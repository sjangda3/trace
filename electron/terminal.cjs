const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { WorkspaceError } = require("./workspace.cjs");
const {
  DEFAULT_TYPING_IDLE_MS,
  ExclusiveControl,
  ExclusiveControlError,
} = require("./exclusive-control.cjs");

const MAX_SESSIONS = 8;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_REPLAY_CHARS = 2 * 1024 * 1024;
const REPLAY_CHUNK_TARGET = 16 * 1024;
const OUTPUT_HIGH_WATER_CHARS = 512 * 1024;
const OUTPUT_LOW_WATER_CHARS = 128 * 1024;
const OUTPUT_HIGH_WATER_EVENTS = 1_024;
const OUTPUT_LOW_WATER_EVENTS = 256;
const MIN_COLUMNS = 2;
const MAX_COLUMNS = 500;
const MIN_ROWS = 1;
const MAX_ROWS = 300;
const TYPING_IDLE_MS = DEFAULT_TYPING_IDLE_MS;
const LOCAL_ACTOR = Object.freeze({ id: "local", name: "You" });
const DEFAULT_CONTEXT = Object.freeze({ actor: LOCAL_ACTOR, clientId: "local-window" });

function boundedInteger(value, minimum, maximum, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new WorkspaceError("INVALID_REQUEST", "The terminal dimensions are invalid.");
  }
  return value;
}

function safeEnvironment(source = process.env) {
  const allowed = new Set([
    "HOME",
    "LANG",
    "LOGNAME",
    "PATH",
    "SHELL",
    "TEMP",
    "TMP",
    "TMPDIR",
    "TZ",
    "USER",
    "__CF_USER_TEXT_ENCODING",
  ]);
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== "string") continue;
    if (allowed.has(key) || key.startsWith("LC_")) env[key] = value;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.TERM_PROGRAM = "Trace";
  return env;
}

function resolveUserShell(environment = process.env, accountShell) {
  const candidates = [accountShell, environment.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) continue;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next trusted system shell.
    }
  }
  throw new WorkspaceError("TERMINAL_UNAVAILABLE", "No supported local shell could be found.");
}

function defaultPtyModule() {
  // Kept lazy so backend unit tests can inject a fake without loading a native ABI.
  return require("node-pty");
}

function controlOperation(operation) {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ExclusiveControlError) {
      throw new WorkspaceError(error.code, error.message);
    }
    throw error;
  }
}

class TerminalManager {
  #workspaceManager;
  #ptyModule;
  #clock;
  #userShell;
  #sessions = new Map();
  #dataListeners = new Set();
  #exitListeners = new Set();
  #controlListeners = new Set();

  constructor({
    workspaceManager,
    ptyModule,
    clock = () => Date.now(),
    userShell = () => os.userInfo().shell,
  }) {
    this.#workspaceManager = workspaceManager;
    this.#ptyModule = ptyModule ?? defaultPtyModule();
    this.#clock = clock;
    this.#userShell = userShell;
  }

  onData(listener) {
    this.#dataListeners.add(listener);
    return () => this.#dataListeners.delete(listener);
  }

  onExit(listener) {
    this.#exitListeners.add(listener);
    return () => this.#exitListeners.delete(listener);
  }

  onControlChanged(listener) {
    this.#controlListeners.add(listener);
    return () => this.#controlListeners.delete(listener);
  }

  get activeCount() {
    return this.#sessions.size;
  }

  createSession({ workspaceId, cols, rows } = {}, context = DEFAULT_CONTEXT) {
    const { actor, clientId } = this.#validateContext(context);
    const executionContext = this.#workspaceManager.getExecutionContext(workspaceId);
    const workspaceSessions = [...this.#sessions.values()].filter(
      (session) => session.workspaceId === workspaceId && session.clientId === clientId,
    );
    if (workspaceSessions.length >= MAX_SESSIONS) {
      throw new WorkspaceError("TERMINAL_LIMIT", `A workspace can have at most ${MAX_SESSIONS} terminals.`);
    }

    let accountShell;
    try {
      accountShell = this.#userShell();
    } catch {
      accountShell = undefined;
    }
    const shell = resolveUserShell(process.env, accountShell);
    const environment = safeEnvironment();
    if (process.platform === "darwin" && path.basename(shell) === "bash") {
      environment.BASH_SILENCE_DEPRECATION_WARNING = "1";
    }
    const dimensions = {
      cols: boundedInteger(cols, MIN_COLUMNS, MAX_COLUMNS, 80),
      rows: boundedInteger(rows, MIN_ROWS, MAX_ROWS, 24),
    };
    const terminalProcess = this.#ptyModule.spawn(shell, [], {
      name: "xterm-256color",
      cols: dimensions.cols,
      rows: dimensions.rows,
      cwd: executionContext.rootPath,
      env: environment,
      handleFlowControl: true,
    });
    const id = crypto.randomUUID();
    const session = {
      id,
      clientId,
      workspaceId,
      title: path.basename(shell),
      shell,
      pid: terminalProcess.pid,
      process: terminalProcess,
      cols: dimensions.cols,
      rows: dimensions.rows,
      createdAt: this.#clock(),
      exited: false,
      exitCode: null,
      signal: null,
      outputChunks: [],
      outputChars: 0,
      sequence: 0,
      pendingOutput: [],
      unackedChars: 0,
      outputPaused: false,
      control: new ExclusiveControl({
        owner: actor,
        clock: this.#clock,
        idleMs: TYPING_IDLE_MS,
      }),
      controlDisposable: null,
      dataDisposable: null,
      exitDisposable: null,
    };

    session.dataDisposable = terminalProcess.onData((data) => this.#handleData(session, data));
    session.exitDisposable = terminalProcess.onExit((event) => this.#handleExit(session, event));
    session.controlDisposable = session.control.onDidChange(() => {
      if (this.#sessions.has(session.id)) this.#emitControl(session);
    });
    this.#sessions.set(id, session);
    return this.#snapshot(session, actor);
  }

  listSessions(workspaceId, context = DEFAULT_CONTEXT) {
    const { actor, clientId } = this.#validateContext(context);
    this.#assertCurrentWorkspace(workspaceId);
    return [...this.#sessions.values()]
      .filter((session) => session.workspaceId === workspaceId && session.clientId === clientId)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((session) => this.#snapshot(session, actor));
  }

  attachSession({ workspaceId, sessionId } = {}, context = DEFAULT_CONTEXT) {
    const { actor } = this.#validateContext(context);
    const session = this.#requireSession(workspaceId, sessionId, context.clientId);
    return this.#snapshot(session, actor);
  }

  ackOutput({ workspaceId, sessionId, sequence } = {}, context = DEFAULT_CONTEXT) {
    this.#validateContext(context);
    const session = this.#requireSession(workspaceId, sessionId, context.clientId);
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > session.sequence) {
      throw new WorkspaceError("INVALID_REQUEST", "The terminal output acknowledgement is invalid.");
    }
    if (sequence > 0 && session.pendingOutput.length > 0) {
      let acknowledgedChars = 0;
      session.pendingOutput = session.pendingOutput.filter((entry) => {
        if (entry.sequence > sequence) return true;
        acknowledgedChars += entry.size;
        return false;
      });
      session.unackedChars = Math.max(0, session.unackedChars - acknowledgedChars);
    }
    if (
      session.outputPaused &&
      session.unackedChars <= OUTPUT_LOW_WATER_CHARS &&
      session.pendingOutput.length <= OUTPUT_LOW_WATER_EVENTS
    ) {
      try {
        session.process.resume?.();
        session.outputPaused = false;
      } catch {
        // The process may have exited while output was being rendered.
      }
    }
    return { sequence, paused: session.outputPaused };
  }

  writeInput({ workspaceId, sessionId, data } = {}, context = DEFAULT_CONTEXT) {
    const { actor } = this.#validateContext(context);
    const session = this.#requireSession(workspaceId, sessionId, context.clientId);
    if (typeof data !== "string" || Buffer.byteLength(data, "utf8") > MAX_INPUT_BYTES) {
      throw new WorkspaceError("INVALID_REQUEST", "The terminal input is invalid or too large.");
    }
    if (session.exited) throw new WorkspaceError("TERMINAL_EXITED", "This terminal process has exited.");
    if (!controlOperation(() => session.control.snapshot(actor)).localHasControl) {
      throw new WorkspaceError("NOT_CONTROL_OWNER", "Take control before typing in this terminal.");
    }

    if (data.length > 0) {
      controlOperation(() => session.control.markTyping(actor));
      session.process.write(data);
    }
    return this.#controlSnapshot(session, actor);
  }

  resizeSession({ workspaceId, sessionId, cols, rows } = {}, context = DEFAULT_CONTEXT) {
    const { actor } = this.#validateContext(context);
    const session = this.#requireSession(workspaceId, sessionId, context.clientId);
    if (!controlOperation(() => session.control.snapshot(actor)).localHasControl) {
      throw new WorkspaceError("NOT_CONTROL_OWNER", "Only the teammate with control can resize this terminal.");
    }
    const nextColumns = boundedInteger(cols, MIN_COLUMNS, MAX_COLUMNS, session.cols);
    const nextRows = boundedInteger(rows, MIN_ROWS, MAX_ROWS, session.rows);
    if (session.exited || (nextColumns === session.cols && nextRows === session.rows)) {
      return { cols: session.cols, rows: session.rows };
    }
    session.process.resize(nextColumns, nextRows);
    session.cols = nextColumns;
    session.rows = nextRows;
    return { cols: nextColumns, rows: nextRows };
  }

  requestControl({ workspaceId, sessionId } = {}, context = DEFAULT_CONTEXT) {
    const { actor } = this.#validateContext(context);
    const session = this.#requireSession(workspaceId, sessionId, context.clientId);
    const snapshot = controlOperation(() => session.control.requestControl(actor));
    return this.#publicControlSnapshot(snapshot);
  }

  closeSession({ workspaceId, sessionId } = {}, context = DEFAULT_CONTEXT) {
    this.#validateContext(context);
    const session = this.#requireSession(workspaceId, sessionId, context.clientId);
    this.#disposeSession(session, true);
    return { sessionId };
  }

  disposeWorkspace(workspaceId) {
    for (const session of [...this.#sessions.values()]) {
      if (session.workspaceId === workspaceId) this.#disposeSession(session, true);
    }
  }

  disposeClient(clientId) {
    for (const session of [...this.#sessions.values()]) {
      if (session.clientId === clientId) this.#disposeSession(session, true);
    }
  }

  disposeAll() {
    for (const session of [...this.#sessions.values()]) this.#disposeSession(session, true);
    this.#dataListeners.clear();
    this.#exitListeners.clear();
    this.#controlListeners.clear();
  }

  #assertCurrentWorkspace(workspaceId) {
    if (typeof workspaceId !== "string" || workspaceId.length === 0) {
      throw new WorkspaceError("INVALID_REQUEST", "The terminal request is missing its workspace identity.");
    }
    if (workspaceId !== this.#workspaceManager.workspaceId) {
      throw new WorkspaceError("WORKSPACE_CHANGED", "The terminal belongs to a different workspace.");
    }
  }

  #validateContext(context) {
    if (
      !context ||
      typeof context.clientId !== "string" ||
      context.clientId.length === 0 ||
      !context.actor ||
      typeof context.actor.id !== "string" ||
      typeof context.actor.name !== "string"
    ) {
      throw new WorkspaceError("INVALID_REQUEST", "The terminal client identity is invalid.");
    }
    return context;
  }

  #requireSession(workspaceId, sessionId, clientId) {
    this.#assertCurrentWorkspace(workspaceId);
    if (typeof sessionId !== "string") {
      throw new WorkspaceError("INVALID_REQUEST", "A terminal session is required.");
    }
    const session = this.#sessions.get(sessionId);
    if (!session || session.workspaceId !== workspaceId || session.clientId !== clientId) {
      throw new WorkspaceError("TERMINAL_NOT_FOUND", "The terminal session no longer exists.");
    }
    return session;
  }

  #handleData(session, data) {
    if (!this.#sessions.has(session.id) || typeof data !== "string" || data.length === 0) return;
    session.sequence += 1;
    this.#appendReplay(session, data);
    session.pendingOutput.push({ sequence: session.sequence, size: data.length });
    session.unackedChars += data.length;
    this.#emit(this.#dataListeners, {
      workspaceId: session.workspaceId,
      clientId: session.clientId,
      sessionId: session.id,
      data,
      sequence: session.sequence,
    });
    if (
      !session.outputPaused &&
      (session.unackedChars >= OUTPUT_HIGH_WATER_CHARS ||
        session.pendingOutput.length >= OUTPUT_HIGH_WATER_EVENTS)
    ) {
      try {
        session.process.pause?.();
        session.outputPaused = true;
      } catch {
        // Backpressure is best-effort for PTY implementations without pause support.
      }
    }
  }

  #appendReplay(session, data) {
    const lastIndex = session.outputChunks.length - 1;
    if (lastIndex >= 0 && session.outputChunks[lastIndex].length < REPLAY_CHUNK_TARGET) {
      session.outputChunks[lastIndex] += data;
    } else {
      session.outputChunks.push(data);
    }
    session.outputChars += data.length;

    while (session.outputChars > MAX_REPLAY_CHARS && session.outputChunks.length > 0) {
      const overflow = session.outputChars - MAX_REPLAY_CHARS;
      const first = session.outputChunks[0];
      if (first.length <= overflow) {
        session.outputChunks.shift();
        session.outputChars -= first.length;
        continue;
      }
      const newline = first.indexOf("\n", overflow);
      const removed = newline === -1 ? overflow : newline + 1;
      session.outputChunks[0] = first.slice(removed);
      session.outputChars -= removed;
      break;
    }
  }

  #handleExit(session, event = {}) {
    if (!this.#sessions.has(session.id) || session.exited) return;
    session.exited = true;
    session.exitCode = Number.isInteger(event.exitCode) ? event.exitCode : null;
    session.signal = Number.isInteger(event.signal) ? event.signal : null;
    controlOperation(() => session.control.stopTyping({ notify: false }));
    this.#emit(this.#exitListeners, {
      workspaceId: session.workspaceId,
      clientId: session.clientId,
      sessionId: session.id,
      exitCode: session.exitCode,
      signal: session.signal,
    });
    this.#emitControl(session);
  }

  #snapshot(session, actor) {
    return {
      id: session.id,
      workspaceId: session.workspaceId,
      title: session.title,
      cols: session.cols,
      rows: session.rows,
      createdAt: session.createdAt,
      exited: session.exited,
      exitCode: session.exitCode,
      signal: session.signal,
      output: session.outputChunks.join(""),
      sequence: session.sequence,
      control: this.#controlSnapshot(session, actor),
    };
  }

  #controlSnapshot(session, actor) {
    return this.#publicControlSnapshot(controlOperation(() => session.control.snapshot(actor)));
  }

  #publicControlSnapshot(snapshot) {
    return {
      ownerId: snapshot.ownerId,
      ownerName: snapshot.ownerName,
      typingCount: snapshot.typingCount,
      localHasControl: snapshot.localHasControl,
      version: snapshot.version,
    };
  }

  #emitControl(session) {
    const snapshot = controlOperation(() => session.control.snapshot());
    this.#emit(this.#controlListeners, {
      workspaceId: session.workspaceId,
      clientId: session.clientId,
      sessionId: session.id,
      control: {
        ownerId: snapshot.ownerId,
        ownerName: snapshot.ownerName,
        typingCount: snapshot.typingCount,
        version: snapshot.version,
      },
    });
  }

  #emit(listeners, event) {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("Terminal listener failed:", error);
      }
    }
  }

  #disposeSession(session, terminateProcess) {
    if (!this.#sessions.delete(session.id)) return;
    session.controlDisposable?.();
    session.control.dispose();
    session.dataDisposable?.dispose?.();
    session.exitDisposable?.dispose?.();
    if (terminateProcess && !session.exited) {
      try {
        session.process.kill();
      } catch {
        // The child may already be exiting.
      }
    }
  }
}

module.exports = {
  LOCAL_ACTOR,
  MAX_SESSIONS,
  TYPING_IDLE_MS,
  TerminalManager,
  resolveUserShell,
  safeEnvironment,
};
