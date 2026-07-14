const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  if (typeof callback !== "function") return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("collabWindow", {
  close: () => ipcRenderer.send("window-control", "close"),
  confirmClose: () => ipcRenderer.send("window-control", "confirm-close"),
  cancelClose: () => ipcRenderer.send("window-control", "cancel-close"),
  minimize: () => ipcRenderer.send("window-control", "minimize"),
  zoom: () => ipcRenderer.send("window-control", "zoom"),
});

contextBridge.exposeInMainWorld("collabWorkspace", {
  openFolder: () => ipcRenderer.invoke("workspace:open-folder"),
  getCurrent: () => ipcRenderer.invoke("workspace:get-current"),
  getTree: (workspaceId) => ipcRenderer.invoke("workspace:get-tree", workspaceId),
  readFile: (relativePath, workspaceId) => ipcRenderer.invoke("workspace:read-file", {
    path: relativePath,
    workspaceId,
  }),
  saveFile: (relativePath, content, expectedMtimeMs, workspaceId) => ipcRenderer.invoke("workspace:save-file", {
    path: relativePath,
    content,
    expectedMtimeMs,
    workspaceId,
  }),
  createFile: (parentPath, name, workspaceId) => ipcRenderer.invoke("workspace:create-file", { parentPath, name, workspaceId }),
  createFolder: (parentPath, name, workspaceId) => ipcRenderer.invoke("workspace:create-folder", { parentPath, name, workspaceId }),
  rename: (relativePath, newName, workspaceId) => ipcRenderer.invoke("workspace:rename", { path: relativePath, newName, workspaceId }),
  delete: (relativePath, workspaceId) => ipcRenderer.invoke("workspace:delete", { path: relativePath, workspaceId }),
  onDidChange: (callback) => subscribe("workspace:changed", callback),
  onCommand: (callback) => subscribe("workspace:command", callback),
});

contextBridge.exposeInMainWorld("collabSearch", {
  search: (request) => ipcRenderer.invoke("search:run", request),
  cancel: (request) => ipcRenderer.invoke("search:cancel", request),
});

contextBridge.exposeInMainWorld("collabTerminal", {
  list: (workspaceId) => ipcRenderer.invoke("terminal:list", workspaceId),
  create: (request) => ipcRenderer.invoke("terminal:create", request),
  attach: (request) => ipcRenderer.invoke("terminal:attach", request),
  resize: (request) => ipcRenderer.invoke("terminal:resize", request),
  close: (request) => ipcRenderer.invoke("terminal:close", request),
  requestControl: (request) => ipcRenderer.invoke("terminal:request-control", request),
  write: (request) => ipcRenderer.send("terminal:write", request),
  ack: (request) => ipcRenderer.send("terminal:ack", request),
  onEvent: (callback) => subscribe("terminal:event", callback),
});

contextBridge.exposeInMainWorld("collabGit", {
  summary: (request) => ipcRenderer.invoke("git:summary", request),
  status: (request) => ipcRenderer.invoke("git:status", request),
  branches: (request) => ipcRenderer.invoke("git:branches", request),
  log: (request) => ipcRenderer.invoke("git:log", request),
  diff: (request) => ipcRenderer.invoke("git:diff", request),
  conflicts: (request) => ipcRenderer.invoke("git:conflicts", request),
  stage: (request) => ipcRenderer.invoke("git:stage", request),
  unstage: (request) => ipcRenderer.invoke("git:unstage", request),
  commit: (request) => ipcRenderer.invoke("git:commit", request),
  checkoutBranch: (request) => ipcRenderer.invoke("git:checkout-branch", request),
  createBranch: (request) => ipcRenderer.invoke("git:create-branch", request),
  onDidChange: (callback) => subscribe("git:changed", callback),
});

contextBridge.exposeInMainWorld("collabGitHub", {
  state: (request) => ipcRenderer.invoke("github:state", request),
  beginDeviceFlow: (request) => ipcRenderer.invoke("github:begin-device-flow", request),
  openDeviceFlow: (request) => ipcRenderer.invoke("github:open-device-flow", request),
  pollDeviceFlow: (request) => ipcRenderer.invoke("github:poll-device-flow", request),
  cancelDeviceFlow: (request) => ipcRenderer.invoke("github:cancel-device-flow", request),
  disconnect: (request) => ipcRenderer.invoke("github:disconnect", request),
  listPullRequests: (request) => ipcRenderer.invoke("github:list-pull-requests", request),
  listIssues: (request) => ipcRenderer.invoke("github:list-issues", request),
  getPullRequest: (request) => ipcRenderer.invoke("github:get-pull-request", request),
  getIssue: (request) => ipcRenderer.invoke("github:get-issue", request),
  onDidChange: (callback) => subscribe("github:changed", callback),
});

contextBridge.exposeInMainWorld("collabAnnotations", {
  list: (request) => ipcRenderer.invoke("annotations:list", request),
  create: (request) => ipcRenderer.invoke("annotations:create", request),
  update: (request) => ipcRenderer.invoke("annotations:update", request),
  resolve: (request) => ipcRenderer.invoke("annotations:resolve", request),
  reply: (request) => ipcRenderer.invoke("annotations:reply", request),
  delete: (request) => ipcRenderer.invoke("annotations:delete", request),
  onDidChange: (callback) => subscribe("annotations:changed", callback),
});

contextBridge.exposeInMainWorld("collabCollaboration", {
  snapshot: (request) => ipcRenderer.invoke("collaboration:snapshot", request),
  createAnnotation: (request) => ipcRenderer.invoke("collaboration:create-annotation", request),
  replyAnnotation: (request) => ipcRenderer.invoke("collaboration:reply-annotation", request),
  resolveAnnotation: (request) => ipcRenderer.invoke("collaboration:resolve-annotation", request),
  requestWriterControl: (request) => ipcRenderer.invoke("collaboration:request-control", request),
  releaseWriterControl: (request) => ipcRenderer.invoke("collaboration:release-control", request),
  markTyping: (request) => ipcRenderer.invoke("collaboration:mark-typing", request),
  onDidChange: (callback) => subscribe("collaboration:changed", callback),
});
