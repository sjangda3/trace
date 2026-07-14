import type { RawResult } from "../editor/bridge";

export type TerminalControl = {
  ownerId: string | null;
  ownerName: string | null;
  typingCount: number;
  localHasControl: boolean;
  version: number;
};

export type TerminalSession = {
  id: string;
  workspaceId: string;
  title: string;
  cols: number;
  rows: number;
  createdAt: number;
  exited: boolean;
  exitCode: number | null;
  signal: number | null;
  output: string;
  sequence: number;
  control: TerminalControl;
};

export type TerminalEvent =
  | { type: "data"; workspaceId: string; sessionId: string; data: string; sequence: number }
  | { type: "exit"; workspaceId: string; sessionId: string; exitCode: number | null; signal: number | null }
  | { type: "control"; workspaceId: string; sessionId: string; control: TerminalControl }
  | { type: "input-rejected"; workspaceId?: string; sessionId?: string; error: { code: string; message: string } };

export type TerminalCreateRequest = { workspaceId: string; cols?: number; rows?: number };
export type TerminalSessionRequest = { workspaceId: string; sessionId: string };
export type TerminalResizeRequest = TerminalSessionRequest & { cols: number; rows: number };
export type TerminalWriteRequest = TerminalSessionRequest & { data: string };
export type TerminalAckRequest = TerminalSessionRequest & { sequence: number };

export interface CollabTerminalBridge {
  list(workspaceId: string): Promise<RawResult<TerminalSession[]>>;
  create(request: TerminalCreateRequest): Promise<RawResult<TerminalSession>>;
  attach(request: TerminalSessionRequest): Promise<RawResult<TerminalSession>>;
  resize(request: TerminalResizeRequest): Promise<RawResult<{ cols: number; rows: number }>>;
  close(request: TerminalSessionRequest): Promise<RawResult<{ sessionId: string }>>;
  requestControl(request: TerminalSessionRequest): Promise<RawResult<TerminalControl>>;
  write(request: TerminalWriteRequest): void;
  ack(request: TerminalAckRequest): void;
  onEvent(callback: (event: TerminalEvent) => void): (() => void) | void;
}

export interface TerminalApi {
  readonly source: "electron" | "demo";
  list(workspaceId: string): Promise<TerminalSession[]>;
  create(request: TerminalCreateRequest): Promise<TerminalSession>;
  attach(request: TerminalSessionRequest): Promise<TerminalSession>;
  resize(request: TerminalResizeRequest): Promise<{ cols: number; rows: number }>;
  close(request: TerminalSessionRequest): Promise<void>;
  requestControl(request: TerminalSessionRequest): Promise<TerminalControl>;
  write(request: TerminalWriteRequest): void;
  ack(request: TerminalAckRequest): void;
  onEvent(callback: (event: TerminalEvent) => void): () => void;
}

declare global {
  interface Window {
    collabTerminal?: CollabTerminalBridge;
  }
}
