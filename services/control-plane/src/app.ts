import Fastify, { type FastifyServerOptions } from "fastify";
import { requireActor, type AuthProvider } from "./auth.js";
import type { RepositoryBinding, WorkspaceMember } from "./domain.js";
import { ApiError, errorPayload } from "./errors.js";
import { InviteTokenCodec } from "./invite-token.js";
import {
  RepositoryError,
  type ControlPlaneRepository,
} from "./repository.js";
import {
  authenticatedHeadersSchema,
  createInviteBodySchema,
  createInviteResponseSchema,
  createWorkspaceBodySchema,
  createWorkspaceResponseSchema,
  errorEnvelopeSchema,
  healthResponseSchema,
  memberSchema,
  membersResponseSchema,
  redeemInviteBodySchema,
  workspaceBootstrapResponseSchema,
  workspaceParamsSchema,
  workspaceSchema,
} from "./schemas.js";

const SERVICE_VERSION = "0.1.0";
const DEFAULT_INVITE_LIFETIME_SECONDS = 86_400;
const MAX_BODY_BYTES = 16 * 1_024;
const INVITE_GENERATION_ATTEMPTS = 3;

type WorkspaceParams = { workspaceId: string };
type CreateWorkspaceBody = { name: string; repository?: RepositoryBinding };
type CreateInviteBody = { expiresInSeconds?: number };
type RedeemInviteBody = { token: string };

export type BuildAppOptions = {
  repository: ControlPlaneRepository;
  authProvider: AuthProvider;
  inviteTokens: InviteTokenCodec;
  logger?: FastifyServerOptions["logger"];
};

function mapRepositoryError(error: RepositoryError): ApiError {
  switch (error.code) {
    case "WORKSPACE_NOT_FOUND":
    case "NOT_MEMBER":
      return new ApiError(404, "WORKSPACE_NOT_FOUND", "The workspace was not found.");
    case "ROLE_REQUIRED":
      return new ApiError(403, "OWNER_REQUIRED", "Workspace owner access is required.");
    case "ACTIVE_INVITE_LIMIT":
      return new ApiError(409, "INVITE_LIMIT_REACHED", "The workspace has too many active invites.");
    case "INVITE_UNAVAILABLE":
      return new ApiError(410, "INVITE_UNAVAILABLE", "This invite is invalid, expired, or already used.");
    case "ALREADY_MEMBER":
      return new ApiError(409, "ALREADY_MEMBER", "You are already a member of this workspace.");
    case "MEMBER_LIMIT":
      return new ApiError(409, "MEMBER_LIMIT_REACHED", "The workspace has reached its member limit.");
    case "INVITE_TOKEN_COLLISION":
      return new ApiError(503, "SERVICE_UNAVAILABLE", "An invite could not be created. Try again.");
  }
}

function normalizeWorkspaceName(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || Buffer.byteLength(normalized, "utf8") > 320) {
    throw new ApiError(400, "INVALID_REQUEST", "The workspace name is invalid.");
  }
  return normalized;
}

function publicMember(member: WorkspaceMember) {
  return {
    workspaceId: member.workspaceId,
    userId: member.userId,
    displayName: member.displayName,
    role: member.role,
    joinedAt: member.joinedAt,
  };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code,
  );
}

function isValidationError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "validation" in error && error.validation);
}

async function requireMembership(
  repository: ControlPlaneRepository,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceMember> {
  const membership = await repository.getMembership(workspaceId, userId);
  if (!membership) {
    throw new ApiError(404, "WORKSPACE_NOT_FOUND", "The workspace was not found.");
  }
  return membership;
}

function protectedRouteSchema(schema: Record<string, unknown>) {
  return {
    ...schema,
    headers: authenticatedHeadersSchema,
  };
}

export function buildApp(options: BuildAppOptions) {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: MAX_BODY_BYTES,
    requestTimeout: 10_000,
    routerOptions: { maxParamLength: 128 },
    ajv: {
      customOptions: {
        removeAdditional: false,
      },
    },
    trustProxy: false,
  });

  app.setNotFoundHandler((request, reply) => {
    const error = new ApiError(404, "NOT_FOUND", "The requested route was not found.");
    return reply.code(error.statusCode).send(errorPayload(error, request));
  });

  app.setErrorHandler((error, request, reply) => {
    let apiError: ApiError;
    if (error instanceof ApiError) {
      apiError = error;
    } else if (error instanceof RepositoryError) {
      apiError = mapRepositoryError(error);
    } else if (hasErrorCode(error, "FST_ERR_CTP_BODY_TOO_LARGE")) {
      apiError = new ApiError(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
    } else if (isValidationError(error) || hasErrorCode(error, "FST_ERR_CTP_INVALID_JSON_BODY")) {
      apiError = new ApiError(400, "INVALID_REQUEST", "The request did not match the API schema.");
    } else {
      request.log.error({ err: error }, "Unhandled control-plane request error");
      apiError = new ApiError(500, "INTERNAL_ERROR", "The request could not be completed.");
    }
    return reply.code(apiError.statusCode).send(errorPayload(apiError, request));
  });

  app.get(
    "/health",
    {
      schema: {
        response: {
          200: healthResponseSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        await options.repository.health();
      } catch (error) {
        request.log.error({ err: error }, "Control-plane repository health check failed");
        const apiError = new ApiError(503, "SERVICE_UNAVAILABLE", "The service is not ready.");
        return reply.code(503).send(errorPayload(apiError, request));
      }
      return reply.send({
        status: "ok",
        service: "trace-control-plane",
        version: SERVICE_VERSION,
      });
    },
  );

  app.post<{ Body: CreateWorkspaceBody }>(
    "/v1/workspaces",
    {
      schema: protectedRouteSchema({
        body: createWorkspaceBodySchema,
        response: {
          201: createWorkspaceResponseSchema,
          default: errorEnvelopeSchema,
        },
      }),
    },
    async (request, reply) => {
      const actor = await requireActor(request, options.authProvider);
      const result = await options.repository.createWorkspace({
        actor,
        name: normalizeWorkspaceName(request.body.name),
        ...(request.body.repository ? { repository: request.body.repository } : {}),
      });
      return reply.code(201).send({
        workspace: result.workspace,
        membership: publicMember(result.membership),
      });
    },
  );

  app.post<{ Params: WorkspaceParams; Body: CreateInviteBody }>(
    "/v1/workspaces/:workspaceId/invites",
    {
      schema: protectedRouteSchema({
        params: workspaceParamsSchema,
        body: createInviteBodySchema,
        response: {
          201: createInviteResponseSchema,
          default: errorEnvelopeSchema,
        },
      }),
    },
    async (request, reply) => {
      const actor = await requireActor(request, options.authProvider);
      const membership = await requireMembership(
        options.repository,
        request.params.workspaceId,
        actor.userId,
      );
      if (membership.role !== "owner") {
        throw new ApiError(403, "OWNER_REQUIRED", "Workspace owner access is required.");
      }

      const expiresInSeconds = request.body.expiresInSeconds ?? DEFAULT_INVITE_LIFETIME_SECONDS;
      for (let attempt = 0; attempt < INVITE_GENERATION_ATTEMPTS; attempt += 1) {
        const issued = options.inviteTokens.issue();
        try {
          const invite = await options.repository.createInvite({
            workspaceId: request.params.workspaceId,
            actor,
            tokenHash: issued.tokenHash,
            expiresInSeconds,
          });
          return reply.code(201).send({ invite: { ...invite, token: issued.token } });
        } catch (error) {
          if (!(error instanceof RepositoryError) || error.code !== "INVITE_TOKEN_COLLISION") {
            throw error;
          }
        }
      }
      throw new ApiError(503, "SERVICE_UNAVAILABLE", "An invite could not be created. Try again.");
    },
  );

  app.post<{ Body: RedeemInviteBody }>(
    "/v1/invites/redeem",
    {
      schema: protectedRouteSchema({
        body: redeemInviteBodySchema,
        response: {
          200: createWorkspaceResponseSchema,
          default: errorEnvelopeSchema,
        },
      }),
    },
    async (request, reply) => {
      const actor = await requireActor(request, options.authProvider);
      const result = await options.repository.redeemInvite({
        actor,
        tokenHash: options.inviteTokens.hash(request.body.token),
      });
      return reply.send({
        workspace: result.workspace,
        membership: publicMember(result.membership),
      });
    },
  );

  app.get<{ Params: WorkspaceParams }>(
    "/v1/workspaces/:workspaceId/members",
    {
      schema: protectedRouteSchema({
        params: workspaceParamsSchema,
        response: {
          200: membersResponseSchema,
          default: errorEnvelopeSchema,
        },
      }),
    },
    async (request, reply) => {
      const actor = await requireActor(request, options.authProvider);
      await requireMembership(options.repository, request.params.workspaceId, actor.userId);
      const members = await options.repository.listMembers(request.params.workspaceId);
      return reply.send({ members: members.map(publicMember) });
    },
  );

  app.get<{ Params: WorkspaceParams }>(
    "/v1/workspaces/:workspaceId/room-snapshot",
    {
      schema: protectedRouteSchema({
        params: workspaceParamsSchema,
        response: {
          200: workspaceBootstrapResponseSchema,
          default: errorEnvelopeSchema,
        },
      }),
    },
    async (request, reply) => {
      const actor = await requireActor(request, options.authProvider);
      const viewer = await requireMembership(
        options.repository,
        request.params.workspaceId,
        actor.userId,
      );
      const bootstrap = await options.repository.getWorkspaceBootstrapState(
        request.params.workspaceId,
      );
      if (!bootstrap) {
        throw new ApiError(404, "WORKSPACE_NOT_FOUND", "The workspace was not found.");
      }
      return reply.send({
        workspace: bootstrap.workspace,
        viewer: publicMember(viewer),
        members: bootstrap.members.map(publicMember),
        codeControl: bootstrap.codeControl,
      });
    },
  );

  return app;
}

export const responseSchemas = {
  workspace: workspaceSchema,
  member: memberSchema,
} as const;
