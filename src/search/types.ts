import type { RawResult } from "../editor/bridge";

export type WorkspaceSearchMatch = {
  line: number;
  column: number;
  endColumn: number;
  preview: string;
  previewStartColumn: number;
  previewTruncatedStart: boolean;
  previewTruncatedEnd: boolean;
};

export type WorkspaceSearchFile = {
  path: string;
  matches: WorkspaceSearchMatch[];
};

export type WorkspaceSearchResult = {
  workspaceId: string;
  requestId: string;
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  files: WorkspaceSearchFile[];
  matchCount: number;
  filesScanned: number;
  filesSkipped: number;
  bytesScanned: number;
  truncated: boolean;
  durationMs: number;
};

export type WorkspaceSearchRequest = {
  workspaceId: string;
  requestId: string;
  query: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  maxResults?: number;
};

export type WorkspaceSearchCancelRequest = {
  workspaceId: string;
  requestId: string;
};

export type WorkspaceSearchCancelResult = WorkspaceSearchCancelRequest & {
  cancelled: boolean;
};

export interface CollabSearchBridge {
  search(request: WorkspaceSearchRequest): Promise<RawResult<WorkspaceSearchResult>>;
  cancel(request: WorkspaceSearchCancelRequest): Promise<RawResult<WorkspaceSearchCancelResult>>;
}

export interface WorkspaceSearchApi {
  readonly source: "electron" | "unavailable";
  search(request: WorkspaceSearchRequest): Promise<WorkspaceSearchResult>;
  cancel(request: WorkspaceSearchCancelRequest): Promise<WorkspaceSearchCancelResult>;
}

declare global {
  interface Window {
    collabSearch?: CollabSearchBridge;
  }
}
