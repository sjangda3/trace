import type { FastifyRequest } from "fastify";
import type { AuthenticatedActor } from "./domain.js";
import { ApiError } from "./errors.js";

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
    return { userId, displayName: userId };
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
  return { userId: actor.userId, displayName };
}
