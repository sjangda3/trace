import type { RawResult } from "../editor/bridge";
import type {
  CollabSearchBridge,
  WorkspaceSearchApi,
  WorkspaceSearchCancelRequest,
  WorkspaceSearchCancelResult,
  WorkspaceSearchRequest,
  WorkspaceSearchResult,
} from "./types";

export class WorkspaceSearchApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WorkspaceSearchApiError";
  }
}

function unwrap<T>(result: RawResult<T>): T {
  if (result.ok) return result.value;
  throw new WorkspaceSearchApiError(result.error.code, result.error.message);
}

class ElectronWorkspaceSearchApi implements WorkspaceSearchApi {
  readonly source = "electron" as const;

  constructor(private readonly bridge: CollabSearchBridge) {}

  async search(request: WorkspaceSearchRequest): Promise<WorkspaceSearchResult> {
    return unwrap(await this.bridge.search(request));
  }

  async cancel(request: WorkspaceSearchCancelRequest): Promise<WorkspaceSearchCancelResult> {
    return unwrap(await this.bridge.cancel(request));
  }
}

class UnavailableWorkspaceSearchApi implements WorkspaceSearchApi {
  readonly source = "unavailable" as const;

  async search(_request: WorkspaceSearchRequest): Promise<WorkspaceSearchResult> {
    throw new WorkspaceSearchApiError(
      "SEARCH_UNAVAILABLE",
      "Workspace search is not connected in this build.",
    );
  }

  async cancel(request: WorkspaceSearchCancelRequest): Promise<WorkspaceSearchCancelResult> {
    return { ...request, cancelled: false };
  }
}

export function createWorkspaceSearchApi(bridge?: CollabSearchBridge): WorkspaceSearchApi {
  const nativeBridge = bridge ?? (typeof window !== "undefined" ? window.collabSearch : undefined);
  return nativeBridge
    ? new ElectronWorkspaceSearchApi(nativeBridge)
    : new UnavailableWorkspaceSearchApi();
}

export const workspaceSearchApi = createWorkspaceSearchApi();
