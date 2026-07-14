import type { FastifyRequest } from "fastify";

export type ApiErrorCode =
  | "INVALID_REQUEST"
  | "PAYLOAD_TOO_LARGE"
  | "UNAUTHENTICATED"
  | "WORKSPACE_NOT_FOUND"
  | "OWNER_REQUIRED"
  | "INVITE_LIMIT_REACHED"
  | "INVITE_UNAVAILABLE"
  | "ALREADY_MEMBER"
  | "MEMBER_LIMIT_REACHED"
  | "SERVICE_UNAVAILABLE"
  | "NOT_FOUND"
  | "INTERNAL_ERROR";

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorPayload(error: ApiError, request: FastifyRequest) {
  return {
    error: {
      code: error.code,
      message: error.message,
      requestId: request.id,
    },
  };
}
