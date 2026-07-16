import Fastify, { type FastifyServerOptions } from "fastify";
import { requireActor, requireVerifiedActor, type AuthProvider } from "./auth.js";
import { AccountService } from "./account-service.js";
import { AccountValidationError, normalizeEmail } from "./accounts.js";
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
const DEFAULT_INVITE_LIFETIME_SECONDS = 604_800;
const MAX_BODY_BYTES = 16 * 1_024;
const INVITE_GENERATION_ATTEMPTS = 3;

type WorkspaceParams = { workspaceId: string };
type CreateWorkspaceBody = { name: string; repository?: RepositoryBinding; installationId?: string };
type CreateInviteBody = { expiresInSeconds?: number; email?: string };
type RedeemInviteBody = { token: string };

export type BuildAppOptions = {
  repository: ControlPlaneRepository;
  authProvider: AuthProvider;
  inviteTokens: InviteTokenCodec;
  accounts?: AccountService;
  requireGitHubRepositoryBinding?: boolean;
  requireInviteEmail?: boolean;
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function tokenLandingPage(title: string, heading: string, body: string, appLink: string, token?: string): string {
  const tokenBlock = token ? `<p>If Trace does not open, copy this one-time code into the app:</p><code>${escapeHtml(token)}</code>` : "";
  return `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><main><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(body)}</p><p><a href="${escapeHtml(appLink)}">Open Trace</a></p>${tokenBlock}</main>`;
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
    } else if (error instanceof AccountValidationError) {
      apiError = new ApiError(400, "INVALID_REQUEST", error.message);
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

  if (options.accounts) {
    const publicEmailSchema = { type: "string", minLength: 3, maxLength: 254 };
    const passwordSchema = { type: "string", minLength: 12, maxLength: 1024 };
    const deviceIdSchema = { type: "string", minLength: 1, maxLength: 128 };
    const rawTokenSchema = { type: "string", minLength: 32, maxLength: 256 };
    const sessionResponse = {
      type: "object",
      required: ["accessToken", "refreshToken", "user"],
      properties: {
        accessToken: { type: "string" }, refreshToken: { type: "string" },
        user: { type: "object", required: ["id", "email", "displayName", "emailVerified", "githubLinked"], properties: { id: { type: "string" }, email: { type: "string" }, displayName: { type: "string" }, emailVerified: { type: "boolean" }, githubLinked: { type: "boolean" } }, additionalProperties: false },
      }, additionalProperties: false,
    };
    const genericAccepted = { type: "object", required: ["accepted"], properties: { accepted: { type: "boolean" } }, additionalProperties: false };
    const authenticated = (schema: Record<string, unknown>) => protectedRouteSchema(schema);
    const requireRate = (request: { ip: string }, route: string, identifier: string, limit: number, seconds: number) => {
      if (!options.accounts!.rateLimit(route, `${request.ip}:${identifier}`, limit, seconds)) {
        throw new ApiError(429, "RATE_LIMITED", "Too many attempts. Try again shortly.");
      }
    };

    app.post<{ Body: { email: string; displayName: string; password: string } }>("/v1/auth/sign-up", {
      schema: { body: { type: "object", required: ["email", "displayName", "password"], properties: { email: publicEmailSchema, displayName: { type: "string", minLength: 1, maxLength: 80 }, password: passwordSchema }, additionalProperties: false }, response: { 202: genericAccepted, default: errorEnvelopeSchema } },
    }, async (request, reply) => {
      const email = normalizeEmail(request.body.email);
      requireRate(request, "sign-up", email, 5, 60 * 60);
      await options.accounts!.signUp(request.body);
      return reply.code(202).send({ accepted: true });
    });

    app.post<{ Body: { email: string; password: string; deviceId: string } }>("/v1/auth/sign-in", {
      schema: { body: { type: "object", required: ["email", "password", "deviceId"], properties: { email: publicEmailSchema, password: { type: "string", minLength: 1, maxLength: 1024 }, deviceId: deviceIdSchema }, additionalProperties: false }, response: { 200: sessionResponse, default: errorEnvelopeSchema } },
    }, async (request, reply) => {
      const email = normalizeEmail(request.body.email);
      requireRate(request, "sign-in", email, 10, 15 * 60);
      const session = await options.accounts!.signIn(request.body);
      if (!session) throw new ApiError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
      return reply.send(session);
    });

    app.post<{ Body: { email: string } }>("/v1/auth/resend-verification", {
      schema: { body: { type: "object", required: ["email"], properties: { email: publicEmailSchema }, additionalProperties: false }, response: { 202: genericAccepted, default: errorEnvelopeSchema } },
    }, async (request, reply) => {
      const email = normalizeEmail(request.body.email);
      requireRate(request, "resend-verification", email, 3, 60 * 60);
      await options.accounts!.resendVerification(email);
      return reply.code(202).send({ accepted: true });
    });

    const verifyEmail = async (token: string) => {
      if (!token || token.length > 256 || !(await options.accounts!.verifyEmail(token))) {
        throw new ApiError(400, "TOKEN_INVALID_OR_EXPIRED", "This verification link is invalid or expired.");
      }
    };
    app.post<{ Body: { token: string } }>("/v1/auth/verify-email", {
      schema: { body: { type: "object", required: ["token"], properties: { token: rawTokenSchema }, additionalProperties: false }, response: { 200: genericAccepted, default: errorEnvelopeSchema } },
    }, async (request, reply) => { requireRate(request, "verify-email", request.ip, 8, 60 * 60); await verifyEmail(request.body.token); return reply.send({ accepted: true }); });
    app.get<{ Querystring: { token?: string } }>("/verify-email", async (request, reply) => {
      try {
        requireRate(request, "verify-email", request.ip, 8, 60 * 60);
        await verifyEmail(request.query.token ?? "");
        return reply.header("referrer-policy", "no-referrer").header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'").type("text/html; charset=utf-8").send(tokenLandingPage("Trace email verified", "Email verified", "Return to Trace and continue setup.", "trace://verified"));
      } catch {
        return reply.code(400).type("text/html; charset=utf-8").send("<!doctype html><title>Trace verification</title><main><h1>Link expired</h1><p>Return to Trace and request a new verification email.</p></main>");
      }
    });

    app.post<{ Body: { email: string } }>("/v1/auth/request-password-reset", {
      schema: { body: { type: "object", required: ["email"], properties: { email: publicEmailSchema }, additionalProperties: false }, response: { 202: genericAccepted, default: errorEnvelopeSchema } },
    }, async (request, reply) => {
      const email = normalizeEmail(request.body.email);
      requireRate(request, "password-reset", email, 3, 60 * 60);
      await options.accounts!.requestPasswordReset(email);
      return reply.code(202).send({ accepted: true });
    });

    app.post<{ Body: { token: string; password: string } }>("/v1/auth/confirm-password-reset", {
      schema: { body: { type: "object", required: ["token", "password"], properties: { token: rawTokenSchema, password: passwordSchema }, additionalProperties: false }, response: { 200: genericAccepted, default: errorEnvelopeSchema } },
    }, async (request, reply) => {
      requireRate(request, "confirm-password-reset", request.ip, 8, 60 * 60);
      if (!(await options.accounts!.resetPassword(request.body.token, request.body.password))) throw new ApiError(400, "TOKEN_INVALID_OR_EXPIRED", "This reset link is invalid or expired.");
      return reply.send({ accepted: true });
    });

    app.get<{ Querystring: { token?: string } }>("/reset-password", async (request, reply) => {
      const token = request.query.token ?? "";
      if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token)) {
        return reply.code(400).type("text/html; charset=utf-8").send("<!doctype html><title>Trace reset</title><main><h1>Link expired</h1><p>Request a new password reset email from Trace.</p></main>");
      }
      return reply.header("referrer-policy", "no-referrer").header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'").type("text/html; charset=utf-8").send(tokenLandingPage("Trace password reset", "Reset your password", "Open Trace to choose a new password.", `trace://reset-password?token=${encodeURIComponent(token)}`, token));
    });

    app.get<{ Querystring: { token?: string } }>("/invite", async (request, reply) => {
      const token = request.query.token ?? "";
      if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token)) {
        return reply.code(400).type("text/html; charset=utf-8").send("<!doctype html><title>Trace invitation</title><main><h1>Invitation unavailable</h1><p>Ask your workspace owner for a new Trace invitation.</p></main>");
      }
      const deepLink = `trace://invite?token=${encodeURIComponent(token)}`;
      return reply.header("referrer-policy", "no-referrer").header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'").type("text/html; charset=utf-8").send(tokenLandingPage("Trace invitation", "You’re invited to Trace", "Open Trace to sign in or create an account and join this workspace.", deepLink));
    });

    app.post<{ Body: { refreshToken: string; deviceId: string } }>("/v1/auth/refresh", {
      schema: { body: { type: "object", required: ["refreshToken", "deviceId"], properties: { refreshToken: rawTokenSchema, deviceId: deviceIdSchema }, additionalProperties: false }, response: { 200: sessionResponse, default: errorEnvelopeSchema } },
    }, async (request, reply) => {
      requireRate(request, "refresh", request.ip, 30, 15 * 60);
      const refreshed = await options.accounts!.refresh(request.body.refreshToken, request.body.deviceId);
      if (!refreshed || refreshed === "reused-or-revoked") throw new ApiError(401, "UNAUTHENTICATED", "Sign in again to continue.");
      return reply.send(refreshed);
    });

    app.post<{ Body: { refreshToken: string } }>("/v1/auth/sign-out", {
      schema: { body: { type: "object", required: ["refreshToken"], properties: { refreshToken: rawTokenSchema }, additionalProperties: false }, response: { 200: genericAccepted, default: errorEnvelopeSchema } },
    }, async (request, reply) => { await options.accounts!.signOut(request.body.refreshToken); return reply.send({ accepted: true }); });

    app.get("/v1/auth/session", { schema: authenticated({ response: { 200: { type: "object", required: ["user"], properties: { user: sessionResponse.properties.user }, additionalProperties: false }, default: errorEnvelopeSchema } }) }, async (request, reply) => {
      const actor = await requireActor(request, options.authProvider);
      const user = await options.accounts!.currentSession(actor);
      if (!user) throw new ApiError(401, "UNAUTHENTICATED", "Authentication is required.");
      return reply.send({ user });
    });

    app.post("/v1/github/link/start", { schema: authenticated({ response: { 200: { type: "object", required: ["authorizationUrl"], properties: { authorizationUrl: { type: "string" } }, additionalProperties: false }, default: errorEnvelopeSchema } }) }, async (request, reply) => {
      const actor = await requireVerifiedActor(request, options.authProvider);
      requireRate(request, "github-link-start", actor.userId, 12, 60 * 60);
      try { return reply.send(await options.accounts!.beginGitHubLink(actor)); }
      catch (error) {
        if (error instanceof Error && error.message === "EMAIL_VERIFICATION_REQUIRED") throw new ApiError(403, "EMAIL_VERIFICATION_REQUIRED", "Verify your email before connecting GitHub.");
        throw error;
      }
    });

    app.get<{ Querystring: { state?: string; code?: string; error?: string } }>("/v1/github/link/callback", async (request, reply) => {
      requireRate(request, "github-link-callback", request.ip, 30, 15 * 60);
      const status = await options.accounts!.completeGitHubLink({ state: request.query.state ?? "", ...(request.query.code ? { code: request.query.code } : {}), denied: request.query.error === "access_denied" });
      const text = status === "linked" ? "GitHub connected. You can return to Trace." : status === "denied" ? "GitHub connection was cancelled. You can return to Trace." : status === "conflict" ? "That GitHub account is already linked to another Trace account." : "This GitHub connection link is invalid or expired.";
      return reply.code(status === "linked" || status === "denied" ? 200 : 400).type("text/html; charset=utf-8").send(`<!doctype html><title>Trace GitHub</title><main><h1>${text}</h1></main>`);
    });

    app.get("/v1/github/app/install-url", { schema: authenticated({ response: { 200: { type: "object", required: ["url"], properties: { url: { type: "string" } }, additionalProperties: false }, default: errorEnvelopeSchema } }) }, async (request, reply) => {
      await requireVerifiedActor(request, options.authProvider);
      const url = options.accounts!.githubInstallUrl();
      if (!url) throw new ApiError(503, "SERVICE_UNAVAILABLE", "GitHub App setup is unavailable.");
      return reply.send({ url });
    });

    app.get("/v1/github/app/installations", { schema: authenticated({ response: { 200: { type: "object", required: ["installations"], properties: { installations: { type: "array" } }, additionalProperties: false }, default: errorEnvelopeSchema } }) }, async (request, reply) => {
      const actor = await requireVerifiedActor(request, options.authProvider);
      const installations = await options.accounts!.githubInstallations(actor);
      if (!installations) throw new ApiError(403, "GITHUB_LINK_REQUIRED", "Connect GitHub before choosing a repository.");
      return reply.send({ installations });
    });

    app.get<{ Params: { installationId: string } }>("/v1/github/app/installations/:installationId/repositories", { schema: authenticated({ params: { type: "object", required: ["installationId"], properties: { installationId: { type: "string", pattern: "^[0-9]+$" } }, additionalProperties: false }, response: { 200: { type: "object", required: ["repositories"], properties: { repositories: { type: "array" } }, additionalProperties: false }, default: errorEnvelopeSchema } }) }, async (request, reply) => {
      const actor = await requireVerifiedActor(request, options.authProvider);
      const repositories = await options.accounts!.githubRepositories(actor, request.params.installationId);
      if (!repositories) throw new ApiError(403, "GITHUB_APP_ACCESS_DENIED", "That GitHub App installation is not available to this account.");
      return reply.send({ repositories });
    });
  }

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
      const actor = options.accounts ? await requireVerifiedActor(request, options.authProvider) : await requireActor(request, options.authProvider);
      if (options.requireGitHubRepositoryBinding) {
        if (!options.accounts || !request.body.repository || !request.body.installationId) {
          throw new ApiError(400, "INVALID_REQUEST", "Choose a GitHub App repository before creating a cloud workspace.");
        }
        if (!(await options.accounts.ensureRepositoryAccess(actor, request.body.installationId, request.body.repository.owner, request.body.repository.name, request.body.repository.defaultBranch))) {
          throw new ApiError(403, "GITHUB_APP_ACCESS_DENIED", "Trace cannot access the selected GitHub repository.");
        }
      }
      const result = await options.repository.createWorkspace({
        actor,
        name: normalizeWorkspaceName(request.body.name),
        ...(request.body.repository ? { repository: request.body.repository } : {}),
        ...(request.body.installationId ? { githubInstallationId: request.body.installationId } : {}),
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
      const actor = options.accounts ? await requireVerifiedActor(request, options.authProvider) : await requireActor(request, options.authProvider);
      const membership = await requireMembership(
        options.repository,
        request.params.workspaceId,
        actor.userId,
      );
      if (membership.role !== "owner") {
        throw new ApiError(403, "OWNER_REQUIRED", "Workspace owner access is required.");
      }

      const expiresInSeconds = request.body.expiresInSeconds ?? DEFAULT_INVITE_LIFETIME_SECONDS;
      const recipientEmail = request.body.email ? normalizeEmail(request.body.email) : undefined;
      if (options.requireInviteEmail && !recipientEmail) {
        throw new ApiError(400, "INVALID_REQUEST", "An invitee email is required.");
      }
      for (let attempt = 0; attempt < INVITE_GENERATION_ATTEMPTS; attempt += 1) {
        const issued = options.inviteTokens.issue();
        try {
          const invite = await options.repository.createInvite({
            workspaceId: request.params.workspaceId,
            actor,
            tokenHash: issued.tokenHash,
            expiresInSeconds,
            ...(recipientEmail ? { recipientEmail } : {}),
          });
          let link: string | undefined;
          if (options.accounts && recipientEmail) {
            const workspace = await options.repository.getWorkspace(request.params.workspaceId);
            try {
              link = await options.accounts.sendWorkspaceInvite({ email: recipientEmail, workspaceName: workspace?.name ?? "Trace workspace", inviterName: actor.displayName, token: issued.token, expiresAt: invite.expiresAt });
            } catch (error) {
              request.log.error({ err: error }, "Trace workspace invite email could not be delivered");
            }
          }
          return reply.code(201).send({ invite: { ...invite, token: issued.token, ...(link ? { link } : {}) } });
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
      const actor = options.accounts ? await requireVerifiedActor(request, options.authProvider) : await requireActor(request, options.authProvider);
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
      const actor = options.accounts ? await requireVerifiedActor(request, options.authProvider) : await requireActor(request, options.authProvider);
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
      const actor = options.accounts ? await requireVerifiedActor(request, options.authProvider) : await requireActor(request, options.authProvider);
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
