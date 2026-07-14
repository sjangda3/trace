import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface TerminalActor {
  id: string;
  name: string;
}

interface TerminalContext {
  actor: TerminalActor;
  clientId: string;
}

interface TerminalControl {
  ownerId: string;
  ownerName: string;
  typingCount: number;
  localHasControl: boolean;
  version: number;
}

interface TerminalSnapshot {
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
}

interface TerminalManagerInstance {
  readonly activeCount: number;
  onData(listener: (event: Record<string, unknown>) => void): () => void;
  onExit(listener: (event: Record<string, unknown>) => void): () => void;
  onControlChanged(listener: (event: Record<string, unknown>) => void): () => void;
  createSession(
    request?: { workspaceId?: string; cols?: number; rows?: number },
    context?: TerminalContext,
  ): TerminalSnapshot;
  listSessions(workspaceId: string, context?: TerminalContext): TerminalSnapshot[];
  attachSession(
    request?: { workspaceId?: string; sessionId?: string },
    context?: TerminalContext,
  ): TerminalSnapshot;
  ackOutput(
    request?: { workspaceId?: string; sessionId?: string; sequence?: number },
    context?: TerminalContext,
  ): { sequence: number; paused: boolean };
  writeInput(
    request?: { workspaceId?: string; sessionId?: string; data?: unknown },
    context?: TerminalContext,
  ): TerminalControl;
  resizeSession(
    request?: { workspaceId?: string; sessionId?: string; cols?: number; rows?: number },
    context?: TerminalContext,
  ): { cols: number; rows: number };
  requestControl(
    request?: { workspaceId?: string; sessionId?: string },
    context?: TerminalContext,
  ): TerminalControl;
  closeSession(
    request?: { workspaceId?: string; sessionId?: string },
    context?: TerminalContext,
  ): { sessionId: string };
  disposeWorkspace(workspaceId: string): void;
  disposeClient(clientId: string): void;
  disposeAll(): void;
}

type DataListener = (data: string) => void;
type ExitListener = (event?: { exitCode?: number; signal?: number }) => void;

class FakePtyProcess {
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  killCount = 0;
  pauseCount = 0;
  resumeCount = 0;
  dataDisposeCount = 0;
  exitDisposeCount = 0;
  private dataListener: DataListener | null = null;
  private exitListener: ExitListener | null = null;

  constructor(readonly pid: number) {}

  onData(listener: DataListener) {
    this.dataListener = listener;
    return {
      dispose: () => {
        this.dataDisposeCount += 1;
        if (this.dataListener === listener) this.dataListener = null;
      },
    };
  }

  onExit(listener: ExitListener) {
    this.exitListener = listener;
    return {
      dispose: () => {
        this.exitDisposeCount += 1;
        if (this.exitListener === listener) this.exitListener = null;
      },
    };
  }

  write(data: string) {
    this.writes.push(data);
  }

  resize(cols: number, rows: number) {
    this.resizes.push([cols, rows]);
  }

  kill() {
    this.killCount += 1;
  }

  pause() {
    this.pauseCount += 1;
  }

  resume() {
    this.resumeCount += 1;
  }

  emitData(data: string) {
    this.dataListener?.(data);
  }

  emitExit(event: { exitCode?: number; signal?: number } = {}) {
    this.exitListener?.(event);
  }
}

interface SpawnRecord {
  shell: string;
  args: string[];
  options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
    handleFlowControl: boolean;
  };
  process: FakePtyProcess;
}

class FakePtyModule {
  readonly spawns: SpawnRecord[] = [];

  spawn(shell: string, args: string[], options: SpawnRecord["options"]) {
    const terminalProcess = new FakePtyProcess(7_000 + this.spawns.length);
    this.spawns.push({ shell, args, options, process: terminalProcess });
    return terminalProcess;
  }
}

class FakeWorkspaceManager {
  workspaceId = "workspace-1";
  rootPath = "/tmp/trace terminal project";

  getExecutionContext(expectedWorkspaceId?: string) {
    if (expectedWorkspaceId !== this.workspaceId) {
      throw new WorkspaceError("WORKSPACE_CHANGED", "The terminal belongs to a different workspace.");
    }
    return { workspaceId: this.workspaceId, rootPath: this.rootPath };
  }
}

const require = createRequire(import.meta.url);
const {
  MAX_SESSIONS,
  TYPING_IDLE_MS,
  TerminalManager,
} = require("../electron/terminal.cjs") as {
  MAX_SESSIONS: number;
  TYPING_IDLE_MS: number;
  TerminalManager: new (options: {
    workspaceManager: FakeWorkspaceManager;
    ptyModule: FakePtyModule;
    clock?: () => number;
    userShell?: () => string | undefined;
  }) => TerminalManagerInstance;
};
const { WorkspaceError } = require("../electron/workspace.cjs") as {
  WorkspaceError: new (code: string, message: string) => Error & { code: string };
};

const alice: TerminalContext = {
  actor: { id: "alice", name: "Alice" },
  clientId: "window-a",
};
const bobInAliceWindow: TerminalContext = {
  actor: { id: "bob", name: "Bob" },
  clientId: "window-a",
};
const aliceOtherWindow: TerminalContext = {
  actor: { id: "alice", name: "Alice" },
  clientId: "window-b",
};

function thrownBy(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the terminal operation to throw.");
}

describe("TerminalManager backend", () => {
  let workspaceManager: FakeWorkspaceManager;
  let ptyModule: FakePtyModule;
  let now: number;
  let manager: TerminalManagerInstance;
  const managers = new Set<TerminalManagerInstance>();
  const environmentKeys = [
    "SHELL",
    "LANG",
    "TRACE_TERMINAL_TEST",
    "NODE_OPTIONS",
    "ELECTRON_RUN_AS_NODE",
    "ELECTRON_TEST_SECRET",
    "VITE_TEST_SECRET",
    "GITHUB_PERSONAL_ACCESS_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "DATABASE_PASSWORD",
    "SSH_AUTH_SOCK",
  ] as const;
  let previousEnvironment: Record<(typeof environmentKeys)[number], string | undefined>;

  function makeManager() {
    const nextManager = new TerminalManager({
      workspaceManager,
      ptyModule,
      clock: () => now,
      userShell: () => undefined,
    });
    managers.add(nextManager);
    return nextManager;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    previousEnvironment = Object.fromEntries(
      environmentKeys.map((key) => [key, process.env[key]]),
    ) as Record<(typeof environmentKeys)[number], string | undefined>;
    process.env.SHELL = "/bin/sh";
    process.env.LANG = "en_US.UTF-8";
    process.env.TRACE_TERMINAL_TEST = "visible";
    process.env.NODE_OPTIONS = "--inspect";
    process.env.ELECTRON_RUN_AS_NODE = "1";
    process.env.ELECTRON_TEST_SECRET = "blocked";
    process.env.VITE_TEST_SECRET = "blocked";
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN = "blocked";
    process.env.AWS_SECRET_ACCESS_KEY = "blocked";
    process.env.DATABASE_PASSWORD = "blocked";
    process.env.SSH_AUTH_SOCK = "/tmp/blocked-agent.sock";

    workspaceManager = new FakeWorkspaceManager();
    ptyModule = new FakePtyModule();
    now = 12_345;
    manager = makeManager();
  });

  afterEach(() => {
    for (const activeManager of managers) activeManager.disposeAll();
    managers.clear();
    for (const key of environmentKeys) {
      const previous = previousEnvironment[key];
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    vi.useRealTimers();
  });

  it("creates a PTY in the workspace with sanitized environment and requested dimensions", () => {
    const snapshot = manager.createSession(
      { workspaceId: workspaceManager.workspaceId, cols: 132, rows: 41 },
      alice,
    );

    expect(ptyModule.spawns).toHaveLength(1);
    const spawn = ptyModule.spawns[0];
    expect(spawn.shell).toBe("/bin/sh");
    expect(spawn.args).toEqual([]);
    expect(spawn.options).toMatchObject({
      name: "xterm-256color",
      cols: 132,
      rows: 41,
      cwd: workspaceManager.rootPath,
      handleFlowControl: true,
    });
    expect(spawn.options.env).toMatchObject({
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "Trace",
    });
    expect(spawn.options.env).not.toHaveProperty("TRACE_TERMINAL_TEST");
    expect(spawn.options.env).not.toHaveProperty("NODE_OPTIONS");
    expect(spawn.options.env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    expect(spawn.options.env).not.toHaveProperty("ELECTRON_TEST_SECRET");
    expect(spawn.options.env).not.toHaveProperty("VITE_TEST_SECRET");
    expect(spawn.options.env).not.toHaveProperty("GITHUB_PERSONAL_ACCESS_TOKEN");
    expect(spawn.options.env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(spawn.options.env).not.toHaveProperty("DATABASE_PASSWORD");
    expect(spawn.options.env).not.toHaveProperty("SSH_AUTH_SOCK");
    expect(snapshot).toMatchObject({
      workspaceId: workspaceManager.workspaceId,
      title: "sh",
      cols: 132,
      rows: 41,
      createdAt: now,
      exited: false,
      output: "",
      sequence: 0,
      control: {
        ownerId: "alice",
        ownerName: "Alice",
        typingCount: 0,
        localHasControl: true,
      },
    });

    now += 1;
    const defaults = manager.createSession({ workspaceId: workspaceManager.workspaceId }, alice);
    expect(defaults).toMatchObject({ cols: 80, rows: 24, createdAt: now });
    expect(ptyModule.spawns[1].options).toMatchObject({ cols: 80, rows: 24 });
  });

  it("rejects requests bound to a workspace that has since changed", () => {
    const session = manager.createSession({ workspaceId: workspaceManager.workspaceId }, alice);
    workspaceManager.workspaceId = "workspace-2";
    workspaceManager.rootPath = "/tmp/replacement";

    expect(thrownBy(() => manager.listSessions("workspace-1", alice))).toMatchObject({
      code: "WORKSPACE_CHANGED",
    });
    expect(
      thrownBy(() => manager.writeInput({ workspaceId: "workspace-1", sessionId: session.id, data: "x" }, alice)),
    ).toMatchObject({ code: "WORKSPACE_CHANGED" });
    expect(
      thrownBy(() => manager.createSession({ workspaceId: "workspace-1" }, alice)),
    ).toMatchObject({ code: "WORKSPACE_CHANGED" });
  });

  it("validates terminal input and resize dimensions before touching the PTY", () => {
    expect(
      thrownBy(() => manager.createSession({ workspaceId: workspaceManager.workspaceId, cols: 1 }, alice)),
    ).toMatchObject({ code: "INVALID_REQUEST" });
    expect(ptyModule.spawns).toHaveLength(0);

    const session = manager.createSession({ workspaceId: workspaceManager.workspaceId }, alice);
    const terminalProcess = ptyModule.spawns[0].process;

    for (const data of [42, null, "x".repeat(64 * 1024 + 1)]) {
      expect(
        thrownBy(() => manager.writeInput({ workspaceId: workspaceManager.workspaceId, sessionId: session.id, data }, alice)),
      ).toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(terminalProcess.writes).toEqual([]);

    const emptyControl = manager.writeInput(
      { workspaceId: workspaceManager.workspaceId, sessionId: session.id, data: "" },
      alice,
    );
    expect(emptyControl.typingCount).toBe(0);
    expect(terminalProcess.writes).toEqual([]);

    for (const dimensions of [
      { cols: 1, rows: 24 },
      { cols: 501, rows: 24 },
      { cols: 80.5, rows: 24 },
      { cols: 80, rows: 0 },
      { cols: 80, rows: 301 },
    ]) {
      expect(
        thrownBy(() => manager.resizeSession({
          workspaceId: workspaceManager.workspaceId,
          sessionId: session.id,
          ...dimensions,
        }, alice)),
      ).toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(terminalProcess.resizes).toEqual([]);

    expect(manager.resizeSession({
      workspaceId: workspaceManager.workspaceId,
      sessionId: session.id,
      cols: 80,
      rows: 24,
    }, alice)).toEqual({ cols: 80, rows: 24 });
    expect(terminalProcess.resizes).toEqual([]);

    expect(manager.resizeSession({
      workspaceId: workspaceManager.workspaceId,
      sessionId: session.id,
      cols: 120,
      rows: 36,
    }, alice)).toEqual({ cols: 120, rows: 36 });
    expect(terminalProcess.resizes).toEqual([[120, 36]]);
  });

  it("emits ordered data and exit events and retains replay state", () => {
    const observed: Array<{ type: string; event: Record<string, unknown> }> = [];
    manager.onData((event) => observed.push({ type: "data", event }));
    manager.onExit((event) => observed.push({ type: "exit", event }));
    manager.onControlChanged((event) => observed.push({ type: "control", event }));
    const session = manager.createSession({ workspaceId: workspaceManager.workspaceId }, alice);
    const terminalProcess = ptyModule.spawns[0].process;

    terminalProcess.emitData("first\n");
    terminalProcess.emitData("second");
    terminalProcess.emitExit({ exitCode: 7, signal: 15 });

    expect(observed.map(({ type }) => type)).toEqual(["data", "data", "exit", "control"]);
    expect(observed[0].event).toMatchObject({
      workspaceId: workspaceManager.workspaceId,
      clientId: alice.clientId,
      sessionId: session.id,
      data: "first\n",
      sequence: 1,
    });
    expect(observed[1].event).toMatchObject({ data: "second", sequence: 2 });
    expect(observed[2].event).toMatchObject({ exitCode: 7, signal: 15 });

    expect(manager.listSessions(workspaceManager.workspaceId, alice)).toEqual([
      expect.objectContaining({
        id: session.id,
        output: "first\nsecond",
        sequence: 2,
        exited: true,
        exitCode: 7,
        signal: 15,
      }),
    ]);
    expect(
      thrownBy(() => manager.writeInput({
        workspaceId: workspaceManager.workspaceId,
        sessionId: session.id,
        data: "after-exit",
      }, alice)),
    ).toMatchObject({ code: "TERMINAL_EXITED" });
  });

  it("atomically attaches with output and exit state emitted before the renderer subscribes", () => {
    const session = manager.createSession({ workspaceId: workspaceManager.workspaceId }, alice);
    const terminalProcess = ptyModule.spawns[0].process;
    terminalProcess.emitData("prompt before attach\r\n");
    terminalProcess.emitData("$ ");
    terminalProcess.emitExit({ exitCode: 0 });

    expect(manager.attachSession({
      workspaceId: workspaceManager.workspaceId,
      sessionId: session.id,
    }, alice)).toMatchObject({
      id: session.id,
      output: "prompt before attach\r\n$ ",
      sequence: 2,
      exited: true,
      exitCode: 0,
    });
  });

  it("bounds replay memory and resumes a paused PTY after output is acknowledged", () => {
    const session = manager.createSession({ workspaceId: workspaceManager.workspaceId }, alice);
    const terminalProcess = ptyModule.spawns[0].process;
    const replayLimit = 2 * 1024 * 1024;
    terminalProcess.emitData("a".repeat(replayLimit));
    terminalProcess.emitData("\nlatest output");

    const attached = manager.attachSession({
      workspaceId: workspaceManager.workspaceId,
      sessionId: session.id,
    }, alice);
    expect(attached.output.length).toBeLessThanOrEqual(replayLimit);
    expect(attached.output).toContain("latest output");
    expect(terminalProcess.pauseCount).toBe(1);

    expect(manager.ackOutput({
      workspaceId: workspaceManager.workspaceId,
      sessionId: session.id,
      sequence: attached.sequence,
    }, alice)).toEqual({ sequence: attached.sequence, paused: false });
    expect(terminalProcess.resumeCount).toBe(1);
    expect(thrownBy(() => manager.ackOutput({
      workspaceId: workspaceManager.workspaceId,
      sessionId: session.id,
      sequence: attached.sequence + 1,
    }, alice))).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("keeps multiple sessions ordered and routes input to the selected process", () => {
    const first = manager.createSession({ workspaceId: workspaceManager.workspaceId }, alice);
    now += 100;
    const second = manager.createSession({ workspaceId: workspaceManager.workspaceId }, alice);

    manager.writeInput({
      workspaceId: workspaceManager.workspaceId,
      sessionId: second.id,
      data: "second-only",
    }, alice);

    expect(manager.activeCount).toBe(2);
    expect(manager.listSessions(workspaceManager.workspaceId, alice).map(({ id }) => id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(ptyModule.spawns[0].process.writes).toEqual([]);
    expect(ptyModule.spawns[1].process.writes).toEqual(["second-only"]);
  });

  it("isolates sessions between renderer clients", () => {
    const session = manager.createSession({ workspaceId: workspaceManager.workspaceId }, alice);

    expect(manager.listSessions(workspaceManager.workspaceId, aliceOtherWindow)).toEqual([]);
    for (const operation of [
      () => manager.writeInput({ workspaceId: workspaceManager.workspaceId, sessionId: session.id, data: "x" }, aliceOtherWindow),
      () => manager.resizeSession({ workspaceId: workspaceManager.workspaceId, sessionId: session.id, cols: 90 }, aliceOtherWindow),
      () => manager.requestControl({ workspaceId: workspaceManager.workspaceId, sessionId: session.id }, aliceOtherWindow),
      () => manager.closeSession({ workspaceId: workspaceManager.workspaceId, sessionId: session.id }, aliceOtherWindow),
    ]) {
      expect(thrownBy(operation)).toMatchObject({ code: "TERMINAL_NOT_FOUND" });
    }
    expect(manager.activeCount).toBe(1);
    expect(ptyModule.spawns[0].process.killCount).toBe(0);
  });

  it("cleans up listeners and the process when a session is explicitly closed", () => {
    const dataEvents: Record<string, unknown>[] = [];
    const exitEvents: Record<string, unknown>[] = [];
    manager.onData((event) => dataEvents.push(event));
    manager.onExit((event) => exitEvents.push(event));
    const session = manager.createSession({ workspaceId: workspaceManager.workspaceId }, alice);
    const terminalProcess = ptyModule.spawns[0].process;

    expect(manager.closeSession({
      workspaceId: workspaceManager.workspaceId,
      sessionId: session.id,
    }, alice)).toEqual({ sessionId: session.id });

    expect(manager.activeCount).toBe(0);
    expect(manager.listSessions(workspaceManager.workspaceId, alice)).toEqual([]);
    expect(terminalProcess).toMatchObject({
      killCount: 1,
      dataDisposeCount: 1,
      exitDisposeCount: 1,
    });
    terminalProcess.emitData("late data");
    terminalProcess.emitExit({ exitCode: 0 });
    expect(dataEvents).toEqual([]);
    expect(exitEvents).toEqual([]);
    expect(
      thrownBy(() => manager.closeSession({
        workspaceId: workspaceManager.workspaceId,
        sessionId: session.id,
      }, alice)),
    ).toMatchObject({ code: "TERMINAL_NOT_FOUND" });
  });

  it("disposes sessions by client and workspace without affecting unrelated clients early", () => {
    manager.createSession({ workspaceId: workspaceManager.workspaceId }, alice);
    manager.createSession({ workspaceId: workspaceManager.workspaceId }, alice);
    manager.createSession({ workspaceId: workspaceManager.workspaceId }, aliceOtherWindow);
    const [first, second, otherClient] = ptyModule.spawns.map(({ process }) => process);

    manager.disposeClient(alice.clientId);
    expect(manager.activeCount).toBe(1);
    expect(first.killCount).toBe(1);
    expect(second.killCount).toBe(1);
    expect(otherClient.killCount).toBe(0);
    expect(manager.listSessions(workspaceManager.workspaceId, alice)).toEqual([]);
    expect(manager.listSessions(workspaceManager.workspaceId, aliceOtherWindow)).toHaveLength(1);

    manager.disposeWorkspace(workspaceManager.workspaceId);
    expect(manager.activeCount).toBe(0);
    expect(otherClient.killCount).toBe(1);
  });

  it("enforces the terminal limit per workspace client", () => {
    expect(MAX_SESSIONS).toBe(8);
    for (let index = 0; index < MAX_SESSIONS; index += 1) {
      manager.createSession({ workspaceId: workspaceManager.workspaceId }, alice);
    }
    expect(manager.activeCount).toBe(MAX_SESSIONS);
    expect(
      thrownBy(() => manager.createSession({ workspaceId: workspaceManager.workspaceId }, alice)),
    ).toMatchObject({ code: "TERMINAL_LIMIT" });
    expect(ptyModule.spawns).toHaveLength(MAX_SESSIONS);

    manager.createSession({ workspaceId: workspaceManager.workspaceId }, aliceOtherWindow);
    expect(manager.activeCount).toBe(MAX_SESSIONS + 1);
  });

  it("blocks control transfer while someone is typing and permits it at the idle boundary", () => {
    const controlEvents: Record<string, unknown>[] = [];
    manager.onControlChanged((event) => controlEvents.push(event));
    const session = manager.createSession({ workspaceId: workspaceManager.workspaceId }, alice);
    const terminalProcess = ptyModule.spawns[0].process;

    const typing = manager.writeInput({
      workspaceId: workspaceManager.workspaceId,
      sessionId: session.id,
      data: "npm test",
    }, alice);
    expect(typing).toMatchObject({ ownerId: "alice", typingCount: 1, localHasControl: true });
    expect(terminalProcess.writes).toEqual(["npm test"]);
    expect(
      thrownBy(() => manager.requestControl({
        workspaceId: workspaceManager.workspaceId,
        sessionId: session.id,
      }, bobInAliceWindow)),
    ).toMatchObject({ code: "CONTROL_BUSY" });
    expect(
      thrownBy(() => manager.writeInput({
        workspaceId: workspaceManager.workspaceId,
        sessionId: session.id,
        data: "unauthorized",
      }, bobInAliceWindow)),
    ).toMatchObject({ code: "NOT_CONTROL_OWNER" });

    now += TYPING_IDLE_MS;
    vi.advanceTimersByTime(TYPING_IDLE_MS);
    const transferred = manager.requestControl({
      workspaceId: workspaceManager.workspaceId,
      sessionId: session.id,
    }, bobInAliceWindow);
    expect(transferred).toEqual({
      ownerId: "bob",
      ownerName: "Bob",
      typingCount: 0,
      localHasControl: true,
      version: 3,
    });
    expect(manager.listSessions(workspaceManager.workspaceId, alice)[0].control).toMatchObject({
      ownerId: "bob",
      typingCount: 0,
      localHasControl: false,
    });
    expect(
      thrownBy(() => manager.resizeSession({
        workspaceId: workspaceManager.workspaceId,
        sessionId: session.id,
        cols: 100,
      }, alice)),
    ).toMatchObject({ code: "NOT_CONTROL_OWNER" });
    expect(controlEvents.at(-1)).toMatchObject({
      sessionId: session.id,
      control: { ownerId: "bob", typingCount: 0, version: 3 },
    });
    expect((controlEvents.at(-1)?.control as Record<string, unknown>)).not.toHaveProperty("localHasControl");
  });
});
