import type { WorkspaceErrorCode } from "./types";

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  readonly path?: string;

  constructor(
    code: WorkspaceErrorCode,
    message: string,
    options: { path?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "WorkspaceError";
    this.code = code;
    this.path = options.path;
  }
}

export function isWorkspaceError(error: unknown): error is WorkspaceError {
  return error instanceof WorkspaceError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const KNOWN_CODES = new Set<WorkspaceErrorCode>([
  "not-available",
  "cancelled",
  "not-found",
  "already-exists",
  "permission-denied",
  "invalid-path",
  "is-directory",
  "not-directory",
  "binary-file",
  "file-too-large",
  "invalid-encoding",
  "conflict",
  "workspace-changed",
  "io-error",
  "unknown",
]);

export function toWorkspaceError(error: unknown, fallbackMessage: string, path?: string): WorkspaceError {
  if (isWorkspaceError(error)) return error;

  if (isRecord(error)) {
    const rawCode = typeof error.code === "string" ? error.code : "unknown";
    const code = KNOWN_CODES.has(rawCode as WorkspaceErrorCode)
      ? (rawCode as WorkspaceErrorCode)
      : inferErrorCode(rawCode);
    const message = typeof error.message === "string" ? error.message : fallbackMessage;
    const errorPath = typeof error.path === "string" ? error.path : path;
    return new WorkspaceError(code, message, { path: errorPath, cause: error });
  }

  const message = error instanceof Error ? error.message : fallbackMessage;
  return new WorkspaceError("unknown", message, { path, cause: error });
}

function inferErrorCode(rawCode: string): WorkspaceErrorCode {
  switch (rawCode.toUpperCase()) {
    case "CANCELLED": return "cancelled";
    case "NO_WORKSPACE": return "not-available";
    case "ENOENT": return "not-found";
    case "NOT_FOUND": return "not-found";
    case "EEXIST": return "already-exists";
    case "ALREADY_EXISTS": return "already-exists";
    case "EACCES":
    case "EPERM":
    case "PERMISSION_DENIED": return "permission-denied";
    case "EISDIR": return "is-directory";
    case "NOT_FILE": return "is-directory";
    case "ENOTDIR":
    case "NOT_DIRECTORY": return "not-directory";
    case "BINARY_FILE": return "binary-file";
    case "INVALID_UTF8": return "invalid-encoding";
    case "FILE_TOO_LARGE": return "file-too-large";
    case "CONFLICT": return "conflict";
    case "WORKSPACE_CHANGED": return "workspace-changed";
    case "INVALID_PATH":
    case "INVALID_NAME":
    case "OUTSIDE_WORKSPACE":
    case "SYMLINK_NOT_ALLOWED":
    case "INVALID_REQUEST": return "invalid-path";
    case "IO_ERROR": return "io-error";
    default: return "unknown";
  }
}
