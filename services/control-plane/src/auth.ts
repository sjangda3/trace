import type { FastifyRequest } from "fastify";
import type { AuthenticatedActor } from "./domain.js";
import { ApiError } from "./errors.js";
import { AccessTokenCodec } from "./accounts.js";
import type { ControlPlaneRepository } from "./repository.js";

const MAX_AUTHORIZATION_BYTES = 512;
const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

export interface AuthProvider {
  authenticate(authorization: string): Promise<AuthenticatedActor | null>;
}

/**
 * Explicit local-development authentication. This is intentionally unsuitable
 * for production and is enabled by the executable only with an opt-in flag.
 */
export class DevBearerAuthProvider implements AuthProvider {
  async authenticate(authorization: string): Promise<AuthenticatedActor | null> {
    if (!authorization.startsWith("Bearer dev:")) return null;
    const userId = authorization.slice("Bearer dev:".length);
    if (!USER_ID_PATTERN.test(userId)) return null;
    return { userId, displayName: userId, emailVerified: true };
  }
}

/** Production access-token boundary. Each request also verifies the backing rotating session. */
export class TraceAccessTokenAuthProvider implements AuthProvider {
  constructor(
    private readonly options: {
      accessTokens: AccessTokenCodec;
      repository: Pick<ControlPlaneRepository, "isDeviceSessionActive">;
      clock?: () => Date;
    },
  ) {}

  async authenticate(authorization: string): Promise<AuthenticatedActor | null> {
    if (!authorization.startsWith("Bearer ")) return null;
    const claims = this.options.accessTokens.verify(authorization.slice(7), (this.options.clock ?? (() => new Date()))());
    if (!claims || !(await this.options.repository.isDeviceSessionActive(claims.sid, claims.sub))) return null;
    return {
      userId: claims.sub,
      displayName: claims.name,
      email: claims.email,
      emailVerified: claims.verified,
    };
  }
}

export async function requireActor(
  request: FastifyRequest,
  authProvider: AuthProvider,
): Promise<AuthenticatedActor> {
  const authorization = request.headers.authorization;
  if (
    typeof authorization !== "string" ||
    Buffer.byteLength(authorization, "utf8") > MAX_AUTHORIZATION_BYTES
  ) {
    throw new ApiError(401, "UNAUTHENTICATED", "Authentication is required.");
  }
  const actor = await authProvider.authenticate(authorization);
  if (!actor || !USER_ID_PATTERN.test(actor.userId)) {
    throw new ApiError(401, "UNAUTHENTICATED", "Authentication is required.");
  }
  const displayName = actor.displayName.trim();
  if (
    displayName.length === 0 ||
    Buffer.byteLength(displayName, "utf8") > 256
  ) {
    throw new ApiError(401, "UNAUTHENTICATED", "Authentication is required.");
  }
  return {
    userId: actor.userId,
    displayName,
    ...(actor.email ? { email: actor.email } : {}),
    ...(typeof actor.emailVerified === "boolean" ? { emailVerified: actor.emailVerified } : {}),
  };
}

export async function requireVerifiedActor(
  request: FastifyRequest,
  authProvider: AuthProvider,
): Promise<AuthenticatedActor> {
  const actor = await requireActor(request, authProvider);
  if (actor.emailVerified === false) {
    throw new ApiError(403, "EMAIL_VERIFICATION_REQUIRED", "Verify your email before using Trace cloud workspaces.");
  }
  return actor;
}
