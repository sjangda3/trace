const UUID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const TIMESTAMP_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$";

export const authenticatedHeadersSchema = {
  type: "object",
  properties: {
    authorization: { type: "string", maxLength: 512 },
  },
  additionalProperties: true,
};

export const workspaceParamsSchema = {
  type: "object",
  required: ["workspaceId"],
  properties: {
    workspaceId: { type: "string", pattern: UUID_PATTERN },
  },
  additionalProperties: false,
};

export const repositoryBindingSchema = {
  type: "object",
  required: ["provider", "owner", "name", "defaultBranch"],
  properties: {
    provider: { type: "string", enum: ["github"] },
    owner: {
      type: "string",
      minLength: 1,
      maxLength: 39,
      pattern: "^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$",
    },
    name: {
      type: "string",
      minLength: 1,
      maxLength: 100,
      pattern: "^(?!\\.)(?!.*\\.git$)[A-Za-z0-9._-]+$",
    },
    defaultBranch: {
      type: "string",
      minLength: 1,
      maxLength: 255,
      pattern: "^(?=.*\\S)(?!/)(?!.*\\.\\.)(?!.*[~^:?*\\[\\]\\\\])[ -~]+$",
    },
  },
  additionalProperties: false,
};

export const createWorkspaceBodySchema = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 80 },
    repository: repositoryBindingSchema,
    installationId: { type: "string", pattern: "^[0-9]+$" },
  },
  additionalProperties: false,
};

export const createInviteBodySchema = {
  type: "object",
  properties: {
    expiresInSeconds: {
      type: "integer",
      minimum: 300,
      maximum: 604800,
    },
    email: { type: "string", minLength: 3, maxLength: 254 },
  },
  additionalProperties: false,
};

export const redeemInviteBodySchema = {
  type: "object",
  required: ["token"],
  properties: {
    token: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
  },
  additionalProperties: false,
};

export const errorEnvelopeSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message", "requestId"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        requestId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

export const workspaceSchema = {
  type: "object",
  required: [
    "id",
    "roomId",
    "name",
    "state",
    "roomSequence",
    "createdByUserId",
    "createdAt",
  ],
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    roomId: { type: "string", pattern: UUID_PATTERN },
    name: { type: "string", minLength: 1, maxLength: 80 },
    state: { type: "string", enum: ["created"] },
    roomSequence: { type: "integer", minimum: 0 },
    createdByUserId: { type: "string", minLength: 1, maxLength: 128 },
    createdAt: { type: "string", pattern: TIMESTAMP_PATTERN },
  },
  additionalProperties: false,
};

export const memberSchema = {
  type: "object",
  required: ["workspaceId", "userId", "displayName", "role", "joinedAt"],
  properties: {
    workspaceId: { type: "string", pattern: UUID_PATTERN },
    userId: { type: "string", minLength: 1, maxLength: 128 },
    displayName: { type: "string", minLength: 1, maxLength: 256 },
    role: { type: "string", enum: ["owner", "member"] },
    joinedAt: { type: "string", pattern: TIMESTAMP_PATTERN },
  },
  additionalProperties: false,
};

const inviteMetadataProperties = {
  id: { type: "string", pattern: UUID_PATTERN },
  workspaceId: { type: "string", pattern: UUID_PATTERN },
  role: { type: "string", enum: ["member"] },
  createdByUserId: { type: "string", minLength: 1, maxLength: 128 },
  createdAt: { type: "string", pattern: TIMESTAMP_PATTERN },
  expiresAt: { type: "string", pattern: TIMESTAMP_PATTERN },
  recipientEmail: { anyOf: [{ type: "string", minLength: 3, maxLength: 254 }, { type: "null" }] },
};

export const createWorkspaceResponseSchema = {
  type: "object",
  required: ["workspace", "membership"],
  properties: {
    workspace: workspaceSchema,
    membership: memberSchema,
  },
  additionalProperties: false,
};

export const createInviteResponseSchema = {
  type: "object",
  required: ["invite"],
  properties: {
    invite: {
      type: "object",
      required: [...Object.keys(inviteMetadataProperties), "token"],
      properties: {
        ...inviteMetadataProperties,
        token: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
        link: { type: "string", maxLength: 2048 },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

export const membersResponseSchema = {
  type: "object",
  required: ["members"],
  properties: {
    members: {
      type: "array",
      maxItems: 50,
      items: memberSchema,
    },
  },
  additionalProperties: false,
};

export const codeControlSchema = {
  type: "object",
  required: ["resource", "holderUserId", "version", "fence", "typingCount", "typingUntil"],
  properties: {
    resource: { type: "string", enum: ["code"] },
    holderUserId: { anyOf: [{ type: "string" }, { type: "null" }] },
    version: { type: "integer", minimum: 0 },
    fence: { type: "integer", minimum: 0 },
    typingCount: { type: "integer", minimum: 0 },
    typingUntil: {
      anyOf: [
        { type: "string", pattern: TIMESTAMP_PATTERN },
        { type: "null" },
      ],
    },
  },
  additionalProperties: false,
};

export const workspaceBootstrapResponseSchema = {
  type: "object",
  required: ["workspace", "viewer", "members", "codeControl"],
  properties: {
    workspace: workspaceSchema,
    viewer: memberSchema,
    members: {
      type: "array",
      maxItems: 50,
      items: memberSchema,
    },
    codeControl: codeControlSchema,
  },
  additionalProperties: false,
};

/** @deprecated The route is a REST bootstrap response, not a wire snapshot. */
export const roomSnapshotResponseSchema = workspaceBootstrapResponseSchema;

export const healthResponseSchema = {
  type: "object",
  required: ["status", "service", "version"],
  properties: {
    status: { type: "string", enum: ["ok"] },
    service: { type: "string", enum: ["trace-control-plane"] },
    version: { type: "string" },
  },
  additionalProperties: false,
};
