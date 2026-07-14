import type { RawResult } from "../editor/bridge";
import type {
  CollabTerminalBridge,
  TerminalAckRequest,
  TerminalApi,
  TerminalControl,
  TerminalCreateRequest,
  TerminalEvent,
  TerminalResizeRequest,
  TerminalSession,
  TerminalSessionRequest,
  TerminalWriteRequest,
} from "./types";

export class TerminalApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "TerminalApiError";
  }
}

function unwrap<T>(result: RawResult<T>): T {
  if (result.ok) return result.value;
  throw new TerminalApiError(result.error.code, result.error.message);
}

class ElectronTerminalApi implements TerminalApi {
  readonly source = "electron" as const;

  constructor(private readonly bridge: CollabTerminalBridge) {}

  async list(workspaceId: string) {
    return unwrap(await this.bridge.list(workspaceId));
  }

  async create(request: TerminalCreateRequest) {
    return unwrap(await this.bridge.create(request));
  }

  async attach(request: TerminalSessionRequest) {
    return unwrap(await this.bridge.attach(request));
  }

  async resize(request: TerminalResizeRequest) {
    return unwrap(await this.bridge.resize(request));
  }

  async close(request: TerminalSessionRequest) {
    unwrap(await this.bridge.close(request));
  }

  async requestControl(request: TerminalSessionRequest) {
    return unwrap(await this.bridge.requestControl(request));
  }

  write(request: TerminalWriteRequest) {
    this.bridge.write(request);
  }

  ack(request: TerminalAckRequest) {
    this.bridge.ack(request);
  }

  onEvent(callback: (event: TerminalEvent) => void) {
    const dispose = this.bridge.onEvent(callback);
    return typeof dispose === "function" ? dispose : () => undefined;
  }
}

class DemoTerminalApi implements TerminalApi {
  readonly source = "demo" as const;
  private sessions = new Map<string, TerminalSession>();
  private listeners = new Set<(event: TerminalEvent) => void>();

  async list(workspaceId: string) {
    return [...this.sessions.values()].filter((session) => session.workspaceId === workspaceId);
  }

  async create(request: TerminalCreateRequest) {
    const id = globalThis.crypto?.randomUUID?.() ?? `demo-${Date.now()}`;
    const output = "\x1b[32mtrace\x1b[0m \x1b[35m~/workspace\x1b[0m\r\n\x1b[31m$\x1b[0m ";
    const session: TerminalSession = {
      id,
      workspaceId: request.workspaceId,
      title: "zsh",
      cols: request.cols ?? 80,
      rows: request.rows ?? 24,
      createdAt: Date.now(),
      exited: false,
      exitCode: null,
      signal: null,
      output,
      sequence: 1,
      control: { ownerId: "local", ownerName: "You", typingCount: 0, localHasControl: true, version: 0 },
    };
    this.sessions.set(id, session);
    return session;
  }

  async attach(request: TerminalSessionRequest) {
    return this.requireSession(request);
  }

  async resize(request: TerminalResizeRequest) {
    const session = this.requireSession(request);
    session.cols = request.cols;
    session.rows = request.rows;
    return { cols: request.cols, rows: request.rows };
  }

  async close(request: TerminalSessionRequest) {
    this.sessions.delete(request.sessionId);
  }

  async requestControl(request: TerminalSessionRequest): Promise<TerminalControl> {
    return this.requireSession(request).control;
  }

  write(request: TerminalWriteRequest) {
    const session = this.requireSession(request);
    if (!session.control.localHasControl || session.exited) return;
    session.sequence += 1;
    session.output += request.data;
    this.emit({
      type: "data",
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      data: request.data,
      sequence: session.sequence,
    });
  }

  ack(_request: TerminalAckRequest) {}

  onEvent(callback: (event: TerminalEvent) => void) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private requireSession(request: TerminalSessionRequest) {
    const session = this.sessions.get(request.sessionId);
    if (!session || session.workspaceId !== request.workspaceId) {
      throw new TerminalApiError("TERMINAL_NOT_FOUND", "The terminal session no longer exists.");
    }
    return session;
  }

  private emit(event: TerminalEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

export function createTerminalApi(bridge?: CollabTerminalBridge): TerminalApi {
  const nativeBridge = bridge ?? (typeof window !== "undefined" ? window.collabTerminal : undefined);
  return nativeBridge ? new ElectronTerminalApi(nativeBridge) : new DemoTerminalApi();
}

export const terminalApi = createTerminalApi();
