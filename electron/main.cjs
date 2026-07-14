const { app, BrowserWindow, Menu, dialog, ipcMain, safeStorage, shell } = require("electron");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const {
  WorkspaceError,
  WorkspaceManager,
  failure,
  success,
} = require("./workspace.cjs");
const { LOCAL_ACTOR, TerminalManager } = require("./terminal.cjs");
const { GitManager } = require("./git.cjs");
const { GitHubManager } = require("./github.cjs");
const { AnnotationManager } = require("./annotations.cjs");
const { CollaborationManager } = require("./collaboration.cjs");
const { WorkspaceSearchManager } = require("./workspace-search.cjs");

app.setName("Trace");

let workspaceManager;
let terminalManager;
let gitManager;
let githubManager;
let annotationManager;
let collaborationManager;
let workspaceSearchManager;
const approvedWindows = new WeakSet();
let quitRequested = false;
let workspaceSwitchPending = false;
const rendererEntryPath = path.resolve(__dirname, "../dist/index.html");

function isAllowedRendererUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "file:") return path.resolve(fileURLToPath(url)) === rendererEntryPath;
    return !app.isPackaged &&
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(url.hostname) &&
      url.port === "5173";
  } catch {
    return false;
  }
}

function sendRendererCommand(command) {
  const window = BrowserWindow.getFocusedWindow();
  if (!window || window.isDestroyed()) return;
  window.webContents.send("workspace:command", command);
}

function installMenu() {
  const template = [
    {
      label: "Trace",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        { label: "Open Folder…", accelerator: "CmdOrCtrl+O", click: () => sendRendererCommand("open-folder") },
        { label: "Save", accelerator: "CmdOrCtrl+S", click: () => sendRendererCommand("save") },
        { type: "separator" },
        { label: "Close Active", accelerator: "CmdOrCtrl+W", click: () => sendRendererCommand("close-editor") },
        { label: "Close Window", accelerator: "CmdOrCtrl+Shift+W", role: "close" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Go",
      submenu: [
        { label: "Quick Open…", accelerator: "CmdOrCtrl+P", click: () => sendRendererCommand("quick-open") },
        { label: "Search in Workspace", accelerator: "CmdOrCtrl+Shift+F", click: () => sendRendererCommand("workspace-search") },
        { type: "separator" },
        { label: "Back", accelerator: "CmdOrCtrl+[", click: () => sendRendererCommand("navigate-back") },
        { label: "Forward", accelerator: "CmdOrCtrl+]", click: () => sendRendererCommand("navigate-forward") },
      ],
    },
    {
      label: "Terminal",
      submenu: [
        { label: "Toggle Terminal", accelerator: "CmdOrCtrl+J", click: () => sendRendererCommand("toggle-terminal") },
        { type: "separator" },
        { label: "New Terminal", accelerator: "Ctrl+Shift+`", click: () => sendRendererCommand("new-terminal") },
        { label: "Kill Active Terminal", click: () => sendRendererCommand("kill-terminal") },
      ],
    },
    {
      label: "Run",
      submenu: [
        { label: "Open Workspace Terminal", click: () => sendRendererCommand("open-terminal") },
      ],
    },
    {
      label: "Collaborate",
      submenu: [
        { label: "Workspace Collaboration", click: () => sendRendererCommand("open-collaboration") },
      ],
    },
    {
      label: "Tools",
      submenu: [
        { label: "Editor Commands…", accelerator: "CmdOrCtrl+Shift+P", click: () => sendRendererCommand("editor-commands") },
        { label: "Built-in Language Support", click: () => sendRendererCommand("language-support") },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [{ label: "Project repository", click: () => shell.openExternal("https://github.com") }],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1250,
    height: 727,
    minWidth: 980,
    minHeight: 620,
    show: false,
    backgroundColor: "#00000000",
    frame: false,
    transparent: true,
    hasShadow: true,
    roundedCorners: true,
    vibrancy: "under-window",
    visualEffectState: "active",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  const terminalClientId = String(window.webContents.id);

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    const currentUrl = window.webContents.getURL();
    if (currentUrl && url !== currentUrl) event.preventDefault();
  });

  window.on("close", (event) => {
    if (approvedWindows.has(window)) return;
    event.preventDefault();
    window.webContents.send("workspace:command", "close-window");
  });
  const disposeWindowClients = () => {
    terminalManager?.disposeClient(terminalClientId);
    workspaceSearchManager?.disposeClient(terminalClientId);
  };
  window.on("closed", disposeWindowClients);
  window.webContents.on("render-process-gone", disposeWindowClients);

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl && isAllowedRendererUrl(devUrl)) {
    void window.loadURL(devUrl);
  } else {
    void window.loadFile(rendererEntryPath);
  }

  window.once("ready-to-show", () => window.show());
}

function isTrustedSender(event) {
  const window = BrowserWindow.fromWebContents(event.sender);
  return Boolean(
    window &&
    !window.isDestroyed() &&
    event.senderFrame === event.sender.mainFrame &&
    isAllowedRendererUrl(event.senderFrame.url),
  );
}

function registerResultHandler(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedSender(event)) {
      return failure(new WorkspaceError("UNTRUSTED_SENDER", "The request did not come from a Trace window."));
    }
    try {
      return success(await handler(event, ...args));
    } catch (error) {
      if (!(error instanceof WorkspaceError)) console.error(`${channel} failed:`, error);
      return failure(error);
    }
  });
}

function registerWorkspaceIpc() {
  registerResultHandler("workspace:open-folder", async (event) => {
    if (workspaceSwitchPending) {
      throw new WorkspaceError("WORKSPACE_SWITCHING", "Wait for the current workspace switch to finish.");
    }
    workspaceSwitchPending = true;
    try {
      const window = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showOpenDialog(window, {
        title: "Open Workspace",
        buttonLabel: "Open",
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled || result.filePaths.length === 0) {
        throw new WorkspaceError("CANCELLED", "Folder selection was cancelled.");
      }
      const previousWorkspaceId = workspaceManager.workspaceId;
      await Promise.all([
        gitManager?.whenIdle(),
        collaborationManager?.whenIdle(previousWorkspaceId),
      ]);
      workspaceSearchManager?.disposeWorkspace(previousWorkspaceId);
      const snapshot = await workspaceManager.openWorkspace(result.filePaths[0]);
      if (previousWorkspaceId && previousWorkspaceId !== snapshot.id) {
        terminalManager?.disposeWorkspace(previousWorkspaceId);
        collaborationManager?.disposeWorkspace(previousWorkspaceId);
      }
      return snapshot;
    } finally {
      workspaceSwitchPending = false;
    }
  });

  registerResultHandler("workspace:get-current", async () => {
    if (!workspaceManager.rootPath) return null;
    return workspaceManager.getSnapshot();
  });

  const requireWorkspaceId = (value) => {
    if (typeof value !== "string" || value.length === 0) {
      throw new WorkspaceError("INVALID_REQUEST", "The workspace request is missing its workspace identity.");
    }
    return value;
  };
  const requireWritableWorkspaceId = (value) => {
    if (workspaceSwitchPending) {
      throw new WorkspaceError("WORKSPACE_SWITCHING", "Wait for the new workspace to finish opening.");
    }
    return requireWorkspaceId(value);
  };

  registerResultHandler("workspace:get-tree", async (_event, workspaceId) => (
    workspaceManager.getTree(requireWorkspaceId(workspaceId))
  ));
  registerResultHandler("workspace:read-file", async (_event, request) => {
    if (!request || typeof request !== "object") throw new WorkspaceError("INVALID_REQUEST", "The read request is invalid.");
    return workspaceManager.readTextFile(request.path, requireWorkspaceId(request.workspaceId));
  });
  registerResultHandler("workspace:save-file", async (_event, request) => {
    if (!request || typeof request !== "object") throw new WorkspaceError("INVALID_REQUEST", "The save request is invalid.");
    const workspaceId = requireWritableWorkspaceId(request.workspaceId);
    return collaborationManager.runWithLocalWriter(workspaceId, () => (
      workspaceManager.saveTextFile(
        request.path,
        request.content,
        request.expectedMtimeMs,
        workspaceId,
      )
    ));
  });
  registerResultHandler("workspace:create-file", async (_event, request) => {
    if (!request || typeof request !== "object") throw new WorkspaceError("INVALID_REQUEST", "The create request is invalid.");
    const workspaceId = requireWritableWorkspaceId(request.workspaceId);
    return collaborationManager.runWithLocalWriter(workspaceId, () => (
      workspaceManager.createFile(request.parentPath, request.name, workspaceId)
    ));
  });
  registerResultHandler("workspace:create-folder", async (_event, request) => {
    if (!request || typeof request !== "object") throw new WorkspaceError("INVALID_REQUEST", "The create request is invalid.");
    const workspaceId = requireWritableWorkspaceId(request.workspaceId);
    return collaborationManager.runWithLocalWriter(workspaceId, () => (
      workspaceManager.createFolder(request.parentPath, request.name, workspaceId)
    ));
  });
  registerResultHandler("workspace:rename", async (_event, request) => {
    if (!request || typeof request !== "object") throw new WorkspaceError("INVALID_REQUEST", "The rename request is invalid.");
    const workspaceId = requireWritableWorkspaceId(request.workspaceId);
    return collaborationManager.runWithLocalWriter(workspaceId, () => (
      workspaceManager.renameEntry(request.path, request.newName, workspaceId)
    ));
  });
  registerResultHandler("workspace:delete", async (_event, request) => {
    if (!request || typeof request !== "object") throw new WorkspaceError("INVALID_REQUEST", "The delete request is invalid.");
    const workspaceId = requireWritableWorkspaceId(request.workspaceId);
    return collaborationManager.runWithLocalWriter(workspaceId, () => (
      workspaceManager.deleteEntry(request.path, workspaceId)
    ));
  });
}

function registerSearchIpc() {
  const search = () => {
    if (!workspaceSearchManager) {
      throw new WorkspaceError("SEARCH_UNAVAILABLE", "Workspace search is unavailable.");
    }
    return workspaceSearchManager;
  };
  registerResultHandler("search:run", async (event, request) => (
    search().search(request, { clientId: String(event.sender.id) })
  ));
  registerResultHandler("search:cancel", async (event, request) => (
    search().cancel(request, { clientId: String(event.sender.id) })
  ));
}

function terminalContext(event) {
  return { actor: LOCAL_ACTOR, clientId: String(event.sender.id) };
}

function requireTerminalManager() {
  if (!terminalManager) {
    throw new WorkspaceError(
      "TERMINAL_UNAVAILABLE",
      "The native terminal service is unavailable. Rebuild native dependencies and restart Trace.",
    );
  }
  return terminalManager;
}

function sendTerminalEvent(event) {
  const window = BrowserWindow.getAllWindows().find(
    (candidate) => String(candidate.webContents.id) === event.clientId,
  );
  if (!window || window.isDestroyed()) return;
  const { clientId: _clientId, ...rest } = event;
  const publicEvent = rest.type === "control"
    ? {
        ...rest,
        control: {
          ...rest.control,
          localHasControl: rest.control.ownerId === LOCAL_ACTOR.id,
        },
      }
    : rest;
  window.webContents.send("terminal:event", publicEvent);
}

function registerTerminalIpc() {
  registerResultHandler("terminal:list", async (event, workspaceId) => (
    requireTerminalManager().listSessions(workspaceId, terminalContext(event))
  ));
  registerResultHandler("terminal:create", async (event, request) => {
    if (!request || typeof request !== "object") throw new WorkspaceError("INVALID_REQUEST", "The terminal request is invalid.");
    return requireTerminalManager().createSession(request, terminalContext(event));
  });
  registerResultHandler("terminal:attach", async (event, request) => {
    if (!request || typeof request !== "object") throw new WorkspaceError("INVALID_REQUEST", "The terminal attach request is invalid.");
    return requireTerminalManager().attachSession(request, terminalContext(event));
  });
  registerResultHandler("terminal:resize", async (event, request) => {
    if (!request || typeof request !== "object") throw new WorkspaceError("INVALID_REQUEST", "The terminal resize request is invalid.");
    return requireTerminalManager().resizeSession(request, terminalContext(event));
  });
  registerResultHandler("terminal:close", async (event, request) => {
    if (!request || typeof request !== "object") throw new WorkspaceError("INVALID_REQUEST", "The terminal close request is invalid.");
    return requireTerminalManager().closeSession(request, terminalContext(event));
  });
  registerResultHandler("terminal:request-control", async (event, request) => {
    if (!request || typeof request !== "object") throw new WorkspaceError("INVALID_REQUEST", "The control request is invalid.");
    return requireTerminalManager().requestControl(request, terminalContext(event));
  });
  ipcMain.on("terminal:write", (event, request) => {
    if (!isTrustedSender(event)) return;
    try {
      requireTerminalManager().writeInput(request, terminalContext(event));
    } catch (error) {
      sendTerminalEvent({
        clientId: String(event.sender.id),
        workspaceId: request?.workspaceId,
        sessionId: request?.sessionId,
        type: "input-rejected",
        error: failure(error).error,
      });
    }
  });
  ipcMain.on("terminal:ack", (event, request) => {
    if (!isTrustedSender(event)) return;
    try {
      requireTerminalManager().ackOutput(request, terminalContext(event));
    } catch {
      // A late acknowledgement is expected when a terminal or workspace closes.
    }
  });
}

function sendGitChanged(workspaceId, reason) {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) return;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send("git:changed", { workspaceId, reason, timestamp: Date.now() });
    }
  }
}

function registerGitIpc() {
  const git = () => {
    if (!gitManager) throw new WorkspaceError("GIT_UNAVAILABLE", "The Git service is unavailable.");
    return gitManager;
  };
  const mutation = (method, reason) => async (_event, request) => {
    if (workspaceSwitchPending) {
      throw new WorkspaceError("WORKSPACE_SWITCHING", "Wait for the new workspace to finish opening.");
    }
    const result = await collaborationManager.runWithLocalWriter(
      request?.workspaceId,
      () => git()[method](request),
    );
    sendGitChanged(request?.workspaceId, reason);
    return result;
  };

  registerResultHandler("git:summary", async (_event, request) => git().getRepositorySummary(request));
  registerResultHandler("git:status", async (_event, request) => git().getStatus(request));
  registerResultHandler("git:branches", async (_event, request) => git().getBranches(request));
  registerResultHandler("git:log", async (_event, request) => git().getLog(request));
  registerResultHandler("git:diff", async (_event, request) => git().getFileDiff(request));
  registerResultHandler("git:conflicts", async (_event, request) => git().refreshConflicts(request));
  registerResultHandler("git:stage", mutation("stage", "stage"));
  registerResultHandler("git:unstage", mutation("unstage", "unstage"));
  registerResultHandler("git:commit", mutation("commit", "commit"));
  registerResultHandler("git:checkout-branch", mutation("checkoutBranch", "checkout"));
  registerResultHandler("git:create-branch", mutation("createBranch", "create-branch"));
}

function sendGitHubChanged(workspaceId, reason) {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) return;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send("github:changed", { workspaceId, reason, timestamp: Date.now() });
    }
  }
}

function registerGitHubIpc() {
  const github = () => {
    if (!githubManager) throw new WorkspaceError("GITHUB_UNAVAILABLE", "The GitHub service is unavailable.");
    return githubManager;
  };
  const connectionMutation = (method, broadcast = true) => async (_event, request) => {
    if (workspaceSwitchPending) {
      throw new WorkspaceError("WORKSPACE_SWITCHING", "Wait for the new workspace to finish opening.");
    }
    const result = await github()[method](request);
    if (broadcast) sendGitHubChanged(request?.workspaceId, "connection");
    return result;
  };

  registerResultHandler("github:state", async (_event, request) => github().getState(request));
  registerResultHandler("github:begin-device-flow", connectionMutation("beginDeviceFlow", false));
  registerResultHandler("github:open-device-flow", async (_event, request) => github().openDeviceFlow(request));
  registerResultHandler("github:poll-device-flow", async (_event, request) => {
    const result = await github().pollDeviceFlow(request);
    if (result?.status === "connected") sendGitHubChanged(request?.workspaceId, "connection");
    return result;
  });
  registerResultHandler("github:cancel-device-flow", connectionMutation("cancelDeviceFlow"));
  registerResultHandler("github:disconnect", connectionMutation("disconnect"));
  registerResultHandler("github:list-pull-requests", async (_event, request) => github().listPullRequests(request));
  registerResultHandler("github:list-issues", async (_event, request) => github().listIssues(request));
  registerResultHandler("github:get-pull-request", async (_event, request) => github().getPullRequest(request));
  registerResultHandler("github:get-issue", async (_event, request) => github().getIssue(request));
}

function sendAnnotationChanged(workspaceId, reason, annotationId) {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) return;
  const event = {
    workspaceId,
    reason,
    annotationId: typeof annotationId === "string" ? annotationId : null,
    timestamp: Date.now(),
  };
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("annotations:changed", event);
  }
}

function registerAnnotationIpc() {
  const annotations = () => {
    if (!annotationManager) {
      throw new WorkspaceError("ANNOTATIONS_UNAVAILABLE", "The local annotation service is unavailable.");
    }
    return annotationManager;
  };
  const localActor = Object.freeze({ memberId: LOCAL_ACTOR.id, displayName: LOCAL_ACTOR.name });
  const mutation = (method, reason) => async (_event, request) => {
    if (workspaceSwitchPending) {
      throw new WorkspaceError("WORKSPACE_SWITCHING", "Wait for the new workspace to finish opening.");
    }
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new WorkspaceError("INVALID_REQUEST", "The annotation request is invalid.");
    }
    const result = await annotations()[method]({ ...request, actor: localActor });
    sendAnnotationChanged(
      request.workspaceId,
      reason,
      result?.annotation?.id ?? result?.id ?? request.annotationId,
    );
    return result;
  };

  registerResultHandler("annotations:list", async (_event, request) => annotations().listAnnotations(request));
  registerResultHandler("annotations:create", mutation("createAnnotation", "create"));
  registerResultHandler("annotations:update", mutation("updateAnnotation", "update"));
  registerResultHandler("annotations:resolve", mutation("resolveAnnotation", "resolve"));
  registerResultHandler("annotations:reply", mutation("appendReply", "reply"));
  registerResultHandler("annotations:delete", mutation("deleteAnnotation", "delete"));
}

function sendCollaborationChanged(event) {
  if (!event || typeof event.workspaceId !== "string" || event.workspaceId.length === 0) return;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("collaboration:changed", event);
  }
}

function registerCollaborationIpc() {
  const collaboration = () => {
    if (!collaborationManager) {
      throw new WorkspaceError("COLLABORATION_UNAVAILABLE", "The local collaboration service is unavailable.");
    }
    return collaborationManager;
  };
  const mutation = (method) => async (_event, request) => {
    if (workspaceSwitchPending) {
      throw new WorkspaceError("WORKSPACE_SWITCHING", "Wait for the new workspace to finish opening.");
    }
    return collaboration()[method](request);
  };

  registerResultHandler("collaboration:snapshot", async (_event, request) => collaboration().snapshot(request));
  registerResultHandler("collaboration:create-annotation", mutation("createAnnotation"));
  registerResultHandler("collaboration:reply-annotation", mutation("replyAnnotation"));
  registerResultHandler("collaboration:resolve-annotation", mutation("resolveAnnotation"));
  registerResultHandler("collaboration:request-control", mutation("requestWriterControl"));
  registerResultHandler("collaboration:release-control", mutation("releaseWriterControl"));
  registerResultHandler("collaboration:mark-typing", mutation("markTyping"));
}

ipcMain.on("window-control", (event, action) => {
  if (!isTrustedSender(event) || !["close", "confirm-close", "cancel-close", "minimize", "zoom"].includes(action)) return;
  const window = BrowserWindow.fromWebContents(event.sender);
  if (action === "close") window.close();
  if (action === "confirm-close") {
    approvedWindows.add(window);
    if (quitRequested) {
      const allApproved = BrowserWindow.getAllWindows().every((candidate) => approvedWindows.has(candidate));
      if (allApproved) app.quit();
    } else {
      window.close();
    }
  }
  if (action === "cancel-close") quitRequested = false;
  if (action === "minimize") window.minimize();
  if (action === "zoom") {
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  }
});

app.whenReady().then(async () => {
  workspaceManager = new WorkspaceManager({
    settingsPath: path.join(app.getPath("userData"), "workspace-state.json"),
  });
  workspaceManager.onDidChange((change) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send("workspace:changed", change);
    }
    sendGitChanged(change.workspaceId, "workspace");
    sendGitHubChanged(change.workspaceId, "repository");
  });
  await workspaceManager.restoreLastWorkspace();
  workspaceSearchManager = new WorkspaceSearchManager({ workspaceManager });
  try {
    terminalManager = new TerminalManager({ workspaceManager });
    terminalManager.onData((event) => sendTerminalEvent({ ...event, type: "data" }));
    terminalManager.onExit((event) => sendTerminalEvent({ ...event, type: "exit" }));
    terminalManager.onControlChanged((event) => sendTerminalEvent({ ...event, type: "control" }));
  } catch (error) {
    terminalManager = null;
    console.error("The native terminal service could not start:", error);
  }
  gitManager = new GitManager({ workspaceManager });
  githubManager = new GitHubManager({
    workspaceManager,
    gitManager,
    safeStorage,
    shell,
    settingsPath: path.join(app.getPath("userData"), "github-connections.v1.json"),
    clientId: process.env.TRACE_GITHUB_CLIENT_ID?.trim() || "",
    appSlug: process.env.TRACE_GITHUB_APP_SLUG?.trim() || "trace",
  });
  annotationManager = new AnnotationManager({
    workspaceManager,
    settingsPath: path.join(app.getPath("userData"), "annotations.v1.json"),
  });
  collaborationManager = new CollaborationManager({
    annotationManager,
    localMember: LOCAL_ACTOR,
  });
  collaborationManager.onDidChange(sendCollaborationChanged);
  registerWorkspaceIpc();
  registerSearchIpc();
  registerTerminalIpc();
  registerGitIpc();
  registerGitHubIpc();
  registerAnnotationIpc();
  registerCollaborationIpc();
  installMenu();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", (event) => {
  const pendingWindows = BrowserWindow.getAllWindows().filter((window) => !approvedWindows.has(window));
  if (pendingWindows.length > 0) {
    event.preventDefault();
    quitRequested = true;
    for (const window of pendingWindows) window.webContents.send("workspace:command", "close-window");
    return;
  }
  terminalManager?.disposeAll();
  workspaceSearchManager?.dispose();
  collaborationManager?.dispose();
  workspaceManager?.dispose();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
