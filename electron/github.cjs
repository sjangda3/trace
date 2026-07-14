const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { WorkspaceError } = require("./workspace.cjs");

const API_ORIGIN = "https://api.github.com";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const API_VERSION = "2026-03-10";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_SETTINGS_BYTES = 1024 * 1024;
const MAX_REVIEW_THREAD_PAGES = 3;
const REFRESH_WINDOW_MS = 5 * 60 * 1000;
const MAX_FLOW_LIFETIME_MS = 30 * 60 * 1000;
const MAX_DEVICE_CODE_BYTES = 4_096;
const MAX_TOKEN_BYTES = 16_384;

const REVIEW_THREADS_QUERY = `
  query TraceReviewThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewDecision
        reviewThreads(first: 100, after: $after) {
          nodes {
            id
            isResolved
            isOutdated
            path
            line
            startLine
            diffSide
            startDiffSide
            comments(first: 100) {
              totalCount
              nodes {
                id
                databaseId
                body
                createdAt
                updatedAt
                url
                diffHunk
                line
                startLine
                originalLine
                originalStartLine
                commit { oid }
                originalCommit { oid }
                author { login avatarUrl url }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
    rateLimit { limit remaining used resetAt resource }
  }
`;

function githubError(code, message, details) {
  const error = new WorkspaceError(code, message);
  if (details && typeof details === "object") {
    for (const [key, value] of Object.entries(details)) error[key] = value;
  }
  return error;
}

function requestObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceError("INVALID_REQUEST", "The GitHub request is invalid.");
  }
  return value;
}

function requiredString(value, label, maxBytes = 4_096) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) throw new WorkspaceError("INVALID_REQUEST", `The GitHub ${label} is invalid.`);
  return value;
}

function workspaceIdFrom(request) {
  return requiredString(requestObject(request).workspaceId, "workspace identity");
}

function boundedInteger(value, { minimum, maximum, fallback, label }) {
  const selected = value === undefined ? fallback : value;
  if (!Number.isInteger(selected) || selected < minimum || selected > maximum) {
    throw new WorkspaceError("INVALID_REQUEST", `The GitHub ${label} is invalid.`);
  }
  return selected;
}

function itemNumber(value) {
  return boundedInteger(value, {
    minimum: 1,
    maximum: 2_147_483_647,
    fallback: NaN,
    label: "item number",
  });
}

function listState(value) {
  const selected = value ?? "open";
  if (!["open", "closed", "all"].includes(selected)) {
    throw new WorkspaceError("INVALID_REQUEST", "The GitHub item state is invalid.");
  }
  return selected;
}

function safeText(value, { required = false, maximum = 1024 * 1024 } = {}) {
  if (value === null || value === undefined) {
    if (required) throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned data that Trace could not safely read.");
    return null;
  }
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximum || value.includes("\0")) {
    throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned data that Trace could not safely read.");
  }
  return value;
}

function safeBoolean(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function safeInteger(value, { nullable = false } = {}) {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned data that Trace could not safely read.");
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned data that Trace could not safely read.");
  }
  return value;
}

function safeId(value) {
  if (typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\0")) return value;
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned data that Trace could not safely read.");
}

function safeDate(value) {
  const text = safeText(value);
  if (text === null) return null;
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) {
    throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned data that Trace could not safely read.");
  }
  return new Date(timestamp).toISOString();
}

function safeUrl(value) {
  const text = safeText(value, { maximum: 8_192 });
  if (text === null) return null;
  try {
    const url = new URL(text);
    const host = url.hostname.toLowerCase();
    const allowed = url.protocol === "https:" && (
      host === "github.com" ||
      host === "api.github.com" ||
      host.endsWith(".githubusercontent.com")
    );
    return allowed ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizeUser(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned data that Trace could not safely read.");
  }
  return {
    id: value.id === undefined || value.id === null ? null : safeId(value.id),
    login: safeText(value.login, { required: true, maximum: 256 }),
    name: safeText(value.name, { maximum: 1_024 }),
    avatarUrl: safeUrl(value.avatar_url ?? value.avatarUrl),
    htmlUrl: safeUrl(value.html_url ?? value.htmlUrl ?? value.url),
  };
}

function normalizeLabel(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned data that Trace could not safely read.");
  }
  const color = safeText(value.color, { maximum: 16 });
  return {
    id: safeId(value.id),
    name: safeText(value.name, { required: true, maximum: 512 }),
    ...(color && /^[0-9a-fA-F]{6}$/.test(color) ? { color: color.toLowerCase() } : {}),
  };
}

function normalizeMilestone(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned data that Trace could not safely read.");
  }
  return {
    id: safeId(value.id),
    number: safeInteger(value.number),
    title: safeText(value.title, { required: true, maximum: 4_096 }),
    state: safeText(value.state, { required: true, maximum: 32 }),
    dueAt: safeDate(value.due_on),
  };
}

function normalizeRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    ref: safeText(value.ref, { required: true, maximum: 4_096 }),
    sha: safeText(value.sha, { required: true, maximum: 128 }),
    label: safeText(value.label, { maximum: 4_096 }),
    repositoryFullName: safeText(value.repo?.full_name, { maximum: 512 }),
  };
}

function normalizedCollection(value, normalizer) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned data that Trace could not safely read.");
  }
  return value.map(normalizer);
}

function normalizePullRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned data that Trace could not safely read.");
  }
  const author = normalizeUser(value.user) ?? { id: null, login: "ghost", name: null, avatarUrl: null, htmlUrl: null };
  const head = normalizeRef(value.head);
  const base = normalizeRef(value.base);
  if (!head || !base) {
    throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned data that Trace could not safely read.");
  }
  const state = value.merged === true || value.merged_at
    ? "merged"
    : safeText(value.state, { required: true, maximum: 32 });
  if (!["open", "closed", "merged"].includes(state)) {
    throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned data that Trace could not safely read.");
  }
  const comments = value.comments === undefined ? 0 : safeInteger(value.comments, { nullable: true }) ?? 0;
  const reviewComments = value.review_comments === undefined
    ? 0
    : safeInteger(value.review_comments, { nullable: true }) ?? 0;
  return {
    id: safeId(value.id),
    number: safeInteger(value.number),
    title: safeText(value.title, { required: true, maximum: 64 * 1024 }),
    state,
    draft: safeBoolean(value.draft),
    author: { login: author.login, name: author.name },
    createdAt: safeDate(value.created_at) ?? new Date(0).toISOString(),
    updatedAt: safeDate(value.updated_at) ?? new Date(0).toISOString(),
    url: safeUrl(value.html_url) ?? `https://github.com/pull/${safeInteger(value.number)}`,
    headRefName: head.ref,
    baseRefName: base.ref,
    headOid: head.sha,
    reviewDecision: ["approved", "changes-requested", "review-required"].includes(value.reviewDecision)
      ? value.reviewDecision
      : null,
    reviewRequested: Array.isArray(value.requested_reviewers) && value.requested_reviewers.length > 0,
    commentCount: comments + reviewComments,
    changedFiles: value.changed_files === undefined ? 0 : safeInteger(value.changed_files, { nullable: true }) ?? 0,
    labels: normalizedCollection(value.labels, normalizeLabel),
  };
}

function normalizeIssue(value, viewerLogin = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned data that Trace could not safely read.");
  }
  const author = normalizeUser(value.user) ?? { login: "ghost", name: null };
  const assignees = normalizedCollection(value.assignees, normalizeUser)
    .filter(Boolean)
    .map((user) => ({ login: user.login, name: user.name }));
  const state = safeText(value.state, { required: true, maximum: 32 });
  if (!["open", "closed"].includes(state)) {
    throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned data that Trace could not safely read.");
  }
  return {
    id: safeId(value.id),
    number: safeInteger(value.number),
    title: safeText(value.title, { required: true, maximum: 64 * 1024 }),
    state,
    author: { login: author.login, name: author.name },
    createdAt: safeDate(value.created_at) ?? new Date(0).toISOString(),
    updatedAt: safeDate(value.updated_at) ?? new Date(0).toISOString(),
    url: safeUrl(value.html_url) ?? `https://github.com/issues/${safeInteger(value.number)}`,
    assignedToViewer: typeof viewerLogin === "string" && assignees.some(
      (assignee) => assignee.login.toLowerCase() === viewerLogin.toLowerCase(),
    ),
    assignees,
    commentCount: value.comments === undefined ? 0 : safeInteger(value.comments, { nullable: true }) ?? 0,
    labels: normalizedCollection(value.labels, normalizeLabel),
  };
}

function normalizeReviewThreads(value, fallbackCommitOid = null) {
  if (!Array.isArray(value)) {
    throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned data that Trace could not safely read.");
  }
  return value.map((thread) => {
    if (!thread || typeof thread !== "object" || Array.isArray(thread)) {
      throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned data that Trace could not safely read.");
    }
    const comments = thread.comments;
    if (!comments || typeof comments !== "object" || !Array.isArray(comments.nodes)) {
      throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned data that Trace could not safely read.");
    }
    const normalizedComments = comments.nodes.map((comment) => {
      if (!comment || typeof comment !== "object" || Array.isArray(comment)) {
        throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned data that Trace could not safely read.");
      }
      const author = normalizeUser(comment.author) ?? { login: "ghost", name: null };
      return {
        id: safeId(comment.id),
        author: { login: author.login, name: author.name },
        body: safeText(comment.body, { required: true }),
        createdAt: safeDate(comment.createdAt) ?? new Date(0).toISOString(),
        updatedAt: safeDate(comment.updatedAt) ?? new Date(0).toISOString(),
        url: safeUrl(comment.url) ?? "https://github.com",
      };
    });
    const firstComment = comments.nodes[0] ?? null;
    const effectiveLine = thread.isOutdated
      ? firstComment?.originalLine ?? firstComment?.originalStartLine ?? thread.line ?? thread.startLine
      : thread.line ?? thread.startLine ?? firstComment?.line ?? firstComment?.startLine;
    const startLine = thread.isOutdated
      ? firstComment?.originalStartLine ?? firstComment?.originalLine ?? effectiveLine
      : thread.startLine ?? firstComment?.startLine ?? effectiveLine;
    const commitOid = thread.isOutdated
      ? firstComment?.originalCommit?.oid ?? firstComment?.commit?.oid ?? fallbackCommitOid
      : firstComment?.commit?.oid ?? firstComment?.originalCommit?.oid ?? fallbackCommitOid;
    if (!Number.isInteger(effectiveLine) || effectiveLine < 1 || !Number.isInteger(startLine) || startLine < 1) {
      throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned a review thread without a usable code location.");
    }
    const side = safeText(thread.diffSide, { maximum: 16 }) ?? "RIGHT";
    if (!["LEFT", "RIGHT"].includes(side) || typeof commitOid !== "string" || commitOid.length === 0) {
      throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned a review thread without a usable code location.");
    }
    return {
      id: safeId(thread.id),
      resolved: safeBoolean(thread.isResolved),
      anchor: {
        path: safeText(thread.path, { required: true, maximum: 4_096 }),
        startLine: Math.min(startLine, effectiveLine),
        endLine: Math.max(startLine, effectiveLine),
        side,
        commitOid,
        outdated: safeBoolean(thread.isOutdated),
        diffHunk: safeText(firstComment?.diffHunk),
      },
      comments: normalizedComments,
    };
  });
}

function normalizePullRequestFile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned data that Trace could not safely read.");
  }
  const statusMap = {
    added: "added",
    modified: "changed",
    changed: "changed",
    removed: "removed",
    renamed: "renamed",
    copied: "copied",
  };
  const status = statusMap[value.status];
  if (!status) throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned an unsupported file status.");
  return {
    path: safeText(value.filename, { required: true, maximum: 4_096 }),
    previousPath: safeText(value.previous_filename, { maximum: 4_096 }),
    status,
    additions: safeInteger(value.additions),
    deletions: safeInteger(value.deletions),
  };
}

function normalizeCheck(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned data that Trace could not safely read.");
  }
  let status;
  if (value.status === "queued" || value.status === "waiting" || value.status === "pending") status = "queued";
  else if (value.status === "in_progress" || value.status === "requested") status = "in-progress";
  else if (value.status === "completed") {
    if (value.conclusion === "success") status = "success";
    else if (value.conclusion === "cancelled") status = "cancelled";
    else if (["neutral", "skipped"].includes(value.conclusion)) status = "neutral";
    else status = "failure";
  } else {
    throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned an unsupported check status.");
  }
  return {
    id: safeId(value.id),
    name: safeText(value.name, { required: true, maximum: 4_096 }),
    status,
    url: safeUrl(value.details_url ?? value.html_url),
  };
}

function normalizeIssueComment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned data that Trace could not safely read.");
  }
  const author = normalizeUser(value.user) ?? { login: "ghost", name: null };
  return {
    id: safeId(value.id),
    author: { login: author.login, name: author.name },
    body: safeText(value.body, { required: true }),
    createdAt: safeDate(value.created_at) ?? new Date(0).toISOString(),
    updatedAt: safeDate(value.updated_at) ?? new Date(0).toISOString(),
    url: safeUrl(value.html_url) ?? "https://github.com",
  };
}

function validateGitHubRepository(value, workspaceId) {
  const candidate = value?.repository && typeof value.repository === "object" ? value.repository : value;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw githubError("GITHUB_REMOTE_REQUIRED", "Add a GitHub remote to this repository before connecting GitHub.");
  }
  const owner = candidate.owner ?? candidate.organization ?? candidate.login;
  const name = candidate.name ?? candidate.repo ?? candidate.repository;
  const localRepositoryKey = candidate.localRepositoryKey;
  const validPart = (part, max) => typeof part === "string" && part.length > 0 && part.length <= max &&
    /^[A-Za-z0-9_.-]+$/.test(part) && part !== "." && part !== "..";
  if (
    !validPart(owner, 100) ||
    !validPart(name, 100) ||
    typeof localRepositoryKey !== "string" ||
    localRepositoryKey.length === 0 ||
    localRepositoryKey.length > 16_384 ||
    localRepositoryKey.includes("\0") ||
    (candidate.host && String(candidate.host).toLowerCase() !== "github.com") ||
    (candidate.provider && candidate.provider !== "github")
  ) {
    throw githubError("GITHUB_REMOTE_REQUIRED", "Add a valid github.com remote to this repository before connecting GitHub.");
  }
  return {
    workspaceId,
    owner,
    name,
    fullName: `${owner}/${name}`,
    url: `https://github.com/${owner}/${name}`,
    remoteName: typeof candidate.remoteName === "string" ? candidate.remoteName : null,
    defaultBranch: typeof candidate.defaultBranch === "string"
      ? candidate.defaultBranch
      : typeof candidate.currentBranch === "string" && candidate.currentBranch.length > 0
        ? candidate.currentBranch
        : "main",
    headOid: typeof candidate.headOid === "string" ? candidate.headOid : null,
    currentBranch: typeof candidate.currentBranch === "string" ? candidate.currentBranch : null,
    localRepositoryKey,
  };
}

function parseRateLimit(headers) {
  if (!headers || typeof headers.get !== "function") return null;
  const integer = (name) => {
    const raw = headers.get(name);
    if (raw === null || raw === "" || !/^\d+$/.test(raw)) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  };
  const reset = integer("x-ratelimit-reset");
  let resetAt = null;
  if (reset !== null) {
    const date = new Date(reset * 1000);
    if (Number.isFinite(date.getTime())) resetAt = date.toISOString();
  }
  const result = {
    limit: integer("x-ratelimit-limit"),
    remaining: integer("x-ratelimit-remaining"),
    used: integer("x-ratelimit-used"),
    resetAt,
    resource: headers.get("x-ratelimit-resource") || null,
  };
  return Object.values(result).every((item) => item === null) ? null : result;
}

function publicAccount(value) {
  return value ? {
    login: value.login,
    name: value.name,
  } : null;
}

function publicRepository(value) {
  return {
    owner: value.owner,
    name: value.name,
    fullName: value.fullName,
    url: value.url,
    defaultBranch: value.defaultBranch,
    remoteName: value.remoteName,
    headOid: value.headOid,
    currentBranch: value.currentBranch,
  };
}

function parseJsonBuffer(buffer) {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned data that Trace could not safely read.");
  }
}

function validateVerificationUri(value) {
  const text = safeText(value, { required: true, maximum: 2_048 });
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.pathname !== "/login/device") {
      throw new Error("unsafe");
    }
    return url.toString();
  } catch {
    throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned an invalid sign-in address.");
  }
}

function tokenRecord(value, now) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned an invalid sign-in response.");
  }
  const accessToken = safeText(value.access_token, { required: true, maximum: MAX_TOKEN_BYTES });
  const refreshToken = safeText(value.refresh_token, { maximum: MAX_TOKEN_BYTES });
  const expiresIn = value.expires_in === undefined
    ? null
    : boundedInteger(value.expires_in, { minimum: 1, maximum: 366 * 24 * 60 * 60, fallback: NaN, label: "token expiry" });
  const refreshExpiresIn = value.refresh_token_expires_in === undefined
    ? null
    : boundedInteger(value.refresh_token_expires_in, {
      minimum: 1,
      maximum: 2 * 366 * 24 * 60 * 60,
      fallback: NaN,
      label: "refresh-token expiry",
    });
  const scopeText = safeText(value.scope, { maximum: 8_192 }) ?? "";
  return {
    accessToken,
    refreshToken,
    expiresAt: expiresIn === null ? null : now + expiresIn * 1000,
    refreshExpiresAt: refreshExpiresIn === null ? null : now + refreshExpiresIn * 1000,
    scopes: scopeText.split(/[\s,]+/).filter(Boolean).slice(0, 100),
    tokenType: safeText(value.token_type, { maximum: 64 }) ?? "bearer",
  };
}

class GitHubManager {
  #workspaceManager;
  #gitManager;
  #fetch;
  #safeStorage;
  #settingsPath;
  #clientId;
  #appSlug;
  #shell;
  #now;
  #randomUUID;
  #flows = new Map();
  #connections = new Map();
  #loaded = null;
  #storeTail = Promise.resolve();
  #refreshes = new Map();

  constructor({
    workspaceManager,
    gitManager,
    fetchImpl = globalThis.fetch?.bind(globalThis),
    safeStorage = null,
    settingsPath,
    clientId,
    appSlug = "trace",
    shell = null,
    now = () => Date.now(),
    randomUUID = crypto.randomUUID,
  } = {}) {
    this.#workspaceManager = workspaceManager;
    this.#gitManager = gitManager;
    this.#fetch = fetchImpl;
    this.#safeStorage = safeStorage;
    this.#settingsPath = settingsPath;
    this.#clientId = clientId;
    this.#appSlug = typeof appSlug === "string" && /^[a-z0-9-]{1,100}$/.test(appSlug) ? appSlug : "trace";
    this.#shell = shell;
    this.#now = now;
    this.#randomUUID = randomUUID;
  }

  async getState(request = {}) {
    const workspaceId = workspaceIdFrom(request);
    const repository = await this.#repository(workspaceId);
    await this.#ensureLoaded();
    const connection = this.#matchingConnection(workspaceId, repository);
    return this.#publicState(repository, connection);
  }

  async beginDeviceFlow(request = {}) {
    const workspaceId = workspaceIdFrom(request);
    const repository = await this.#repository(workspaceId);
    this.#assertConfigured();
    this.#assertSecureStorage();
    const data = await this.#oauthRequest(new URLSearchParams({ client_id: this.#clientId }));
    const deviceCode = safeText(data.device_code, { required: true, maximum: MAX_DEVICE_CODE_BYTES });
    const userCode = safeText(data.user_code, { required: true, maximum: 256 });
    const verificationUri = validateVerificationUri(data.verification_uri);
    const expiresIn = boundedInteger(data.expires_in, {
      minimum: 1,
      maximum: MAX_FLOW_LIFETIME_MS / 1000,
      fallback: NaN,
      label: "device-flow expiry",
    });
    const intervalSeconds = boundedInteger(data.interval, {
      minimum: 1,
      maximum: 60,
      fallback: 5,
      label: "device-flow interval",
    });
    const startedAt = this.#now();
    const flowId = this.#randomUUID();
    requiredString(flowId, "device-flow identity", 256);
    for (const [id, flow] of this.#flows) {
      if (flow.workspaceId === workspaceId) this.#flows.delete(id);
    }
    this.#flows.set(flowId, {
      flowId,
      workspaceId,
      repository,
      deviceCode,
      userCode,
      verificationUri,
      startedAt,
      expiresAt: startedAt + expiresIn * 1000,
      intervalSeconds,
      nextPollAt: startedAt,
    });
    return {
      flowId,
      userCode,
      verificationUri,
      expiresAt: new Date(startedAt + expiresIn * 1000).toISOString(),
      retryAfterSeconds: intervalSeconds,
    };
  }

  async openDeviceFlow(request = {}) {
    const input = requestObject(request);
    const flow = this.#flow(input.flowId);
    if (workspaceIdFrom(input) !== flow.workspaceId) {
      throw new WorkspaceError("WORKSPACE_CHANGED", "The GitHub sign-in attempt belongs to a different workspace.");
    }
    if (this.#now() >= flow.expiresAt) {
      this.#flows.delete(flow.flowId);
      throw githubError("GITHUB_DEVICE_FLOW_EXPIRED", "This GitHub sign-in code has expired. Start again to get a new code.");
    }
    if (!this.#shell || typeof this.#shell.openExternal !== "function") {
      throw githubError("GITHUB_BROWSER_UNAVAILABLE", "Trace could not open the GitHub sign-in page.");
    }
    await this.#shell.openExternal(flow.verificationUri);
    return { opened: true };
  }

  async pollDeviceFlow(request = {}) {
    const input = requestObject(request);
    const flow = this.#flow(input.flowId);
    if (workspaceIdFrom(input) !== flow.workspaceId) {
      throw new WorkspaceError("WORKSPACE_CHANGED", "The GitHub sign-in attempt belongs to a different workspace.");
    }
    const currentTime = this.#now();
    if (currentTime >= flow.expiresAt) {
      this.#flows.delete(flow.flowId);
      return { status: "expired", retryAfterSeconds: 0, message: "The GitHub authorization code expired.", state: null };
    }
    if (currentTime < flow.nextPollAt) {
      return {
        status: "pending",
        retryAfterSeconds: Math.max(1, Math.ceil((flow.nextPollAt - currentTime) / 1000)),
        message: null,
        state: null,
      };
    }

    await this.#assertFlowWorkspace(flow);
    flow.nextPollAt = currentTime + flow.intervalSeconds * 1000;
    const data = await this.#oauthRequest(new URLSearchParams({
      client_id: this.#clientId,
      device_code: flow.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }));

    const oauthError = safeText(data.error, { maximum: 256 });
    if (oauthError === "authorization_pending") {
      return {
        status: "pending",
        retryAfterSeconds: flow.intervalSeconds,
        message: null,
        state: null,
      };
    }
    if (oauthError === "slow_down") {
      flow.intervalSeconds = Math.min(60, flow.intervalSeconds + 5);
      flow.nextPollAt = currentTime + flow.intervalSeconds * 1000;
      return {
        status: "slow-down",
        retryAfterSeconds: flow.intervalSeconds,
        message: null,
        state: null,
      };
    }
    if (oauthError === "access_denied") {
      this.#flows.delete(flow.flowId);
      return { status: "cancelled", retryAfterSeconds: 0, message: "GitHub authorization was cancelled.", state: null };
    }
    if (oauthError === "expired_token") {
      this.#flows.delete(flow.flowId);
      return { status: "expired", retryAfterSeconds: 0, message: "The GitHub authorization code expired.", state: null };
    }
    if (oauthError) {
      this.#flows.delete(flow.flowId);
      throw githubError("GITHUB_AUTH_FAILED", "GitHub sign-in could not be completed. Start again and retry.");
    }

    const tokens = tokenRecord(data, currentTime);
    const accountResponse = await this.#requestWithToken(tokens.accessToken, "/user", {}, flow.repository);
    const account = normalizeUser(accountResponse.data);
    if (!account) throw githubError("GITHUB_AUTH_FAILED", "GitHub could not validate this account.");
    const repositoryResponse = await this.#requestWithToken(
      tokens.accessToken,
      `/repos/${encodeURIComponent(flow.repository.owner)}/${encodeURIComponent(flow.repository.name)}`,
      {},
      flow.repository,
    );
    const defaultBranch = safeText(repositoryResponse.data?.default_branch, { required: true, maximum: 4_096 });
    flow.repository = { ...flow.repository, defaultBranch };
    await this.#assertFlowWorkspace(flow);

    const connection = {
      workspaceId: flow.workspaceId,
      repository: flow.repository,
      account,
      tokens,
      connectedAt: new Date(currentTime).toISOString(),
    };
    await this.#mutateConnections(async () => {
      this.#connections.set(flow.workspaceId, connection);
    });
    this.#flows.delete(flow.flowId);
    return {
      status: "connected",
      retryAfterSeconds: 0,
      message: null,
      state: this.#publicState(flow.repository, connection),
    };
  }

  async cancelDeviceFlow(request = {}) {
    const input = requestObject(request);
    const flowId = requiredString(input.flowId, "device-flow identity", 256);
    const workspaceId = workspaceIdFrom(input);
    const flow = this.#flows.get(flowId);
    if (flow && flow.workspaceId !== workspaceId) {
      throw new WorkspaceError("WORKSPACE_CHANGED", "The GitHub sign-in attempt belongs to a different workspace.");
    }
    this.#flows.delete(flowId);
    return this.getState({ workspaceId });
  }

  async disconnect(request = {}) {
    const workspaceId = workspaceIdFrom(request);
    await this.#repository(workspaceId);
    await this.#mutateConnections(async () => {
      this.#connections.delete(workspaceId);
    });
    for (const [flowId, flow] of this.#flows) {
      if (flow.workspaceId === workspaceId) this.#flows.delete(flowId);
    }
    return this.getState({ workspaceId });
  }

  async listPullRequests(request = {}) {
    const input = requestObject(request);
    const repository = await this.#repository(workspaceIdFrom(input));
    const page = boundedInteger(input.page, { minimum: 1, maximum: 1_000, fallback: 1, label: "page" });
    const perPage = boundedInteger(input.perPage, { minimum: 1, maximum: 100, fallback: 50, label: "page size" });
    const state = listState(input.state);
    const query = new URLSearchParams({ state, sort: "updated", direction: "desc", page: String(page), per_page: String(perPage) });
    const response = await this.#apiRequest(repository, `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls?${query}`);
    if (!Array.isArray(response.data)) throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned data that Trace could not safely read.");
    return {
      items: response.data.map(normalizePullRequest),
      cached: false,
      stale: false,
      cachedAt: new Date(this.#now()).toISOString(),
    };
  }

  async listIssues(request = {}) {
    const input = requestObject(request);
    const repository = await this.#repository(workspaceIdFrom(input));
    const page = boundedInteger(input.page, { minimum: 1, maximum: 1_000, fallback: 1, label: "page" });
    const perPage = boundedInteger(input.perPage, { minimum: 1, maximum: 100, fallback: 50, label: "page size" });
    const state = listState(input.state);
    const query = new URLSearchParams({ state, sort: "updated", direction: "desc", page: String(page), per_page: String(perPage) });
    const response = await this.#apiRequest(repository, `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/issues?${query}`);
    if (!Array.isArray(response.data)) throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned data that Trace could not safely read.");
    const connection = await this.#connectionFor(repository);
    return {
      items: response.data
        .filter((item) => !item?.pull_request)
        .map((item) => normalizeIssue(item, connection.account.login)),
      cached: false,
      stale: false,
      cachedAt: new Date(this.#now()).toISOString(),
    };
  }

  async getPullRequest(request = {}) {
    const input = requestObject(request);
    const repository = await this.#repository(workspaceIdFrom(input));
    const number = itemNumber(input.number);
    const rest = await this.#apiRequest(repository, `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls/${number}`);
    const summary = normalizePullRequest(rest.data);
    const [graphql, filesResponse, checksResponse] = await Promise.all([
      this.#readReviewThreads(repository, number, summary.headOid),
      this.#apiRequest(
        repository,
        `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls/${number}/files?per_page=100`,
      ),
      this.#apiRequest(
        repository,
        `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/commits/${encodeURIComponent(summary.headOid)}/check-runs?per_page=100`,
      ),
    ]);
    if (!Array.isArray(filesResponse.data) || !Array.isArray(checksResponse.data?.check_runs)) {
      throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned data that Trace could not safely read.");
    }
    return {
      ...summary,
      body: safeText(rest.data?.body) ?? "",
      additions: rest.data?.additions === undefined ? 0 : safeInteger(rest.data.additions),
      deletions: rest.data?.deletions === undefined ? 0 : safeInteger(rest.data.deletions),
      mergeable: rest.data?.mergeable === true
        ? "mergeable"
        : rest.data?.mergeable === false
          ? "conflicting"
          : "unknown",
      reviewers: normalizedCollection(rest.data?.requested_reviewers, normalizeUser)
        .filter(Boolean)
        .map((reviewer) => ({ login: reviewer.login, name: reviewer.name })),
      checks: checksResponse.data.check_runs.map(normalizeCheck),
      files: filesResponse.data.map(normalizePullRequestFile),
      reviewThreads: graphql.threads,
      reviewDecision: graphql.reviewDecision ?? summary.reviewDecision,
    };
  }

  async getIssue(request = {}) {
    const input = requestObject(request);
    const repository = await this.#repository(workspaceIdFrom(input));
    const number = itemNumber(input.number);
    const response = await this.#apiRequest(repository, `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/issues/${number}`);
    if (response.data?.pull_request) {
      throw githubError("GITHUB_ITEM_IS_PULL_REQUEST", "This GitHub item is a pull request, not an issue.");
    }
    const connection = await this.#connectionFor(repository);
    const summary = normalizeIssue(response.data, connection.account.login);
    const commentsResponse = await this.#apiRequest(
      repository,
      `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/issues/${number}/comments?per_page=100`,
    );
    if (!Array.isArray(commentsResponse.data)) {
      throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned data that Trace could not safely read.");
    }
    return {
      ...summary,
      body: safeText(response.data?.body) ?? "",
      comments: commentsResponse.data.map(normalizeIssueComment),
    };
  }

  #assertConfigured() {
    if (
      typeof this.#clientId !== "string" ||
      this.#clientId.length === 0 ||
      this.#clientId.length > 256 ||
      /[\0\r\n]/.test(this.#clientId)
    ) throw githubError("GITHUB_NOT_CONFIGURED", "GitHub sign-in is not configured in this build of Trace.");
    if (typeof this.#fetch !== "function") {
      throw githubError("GITHUB_UNAVAILABLE", "GitHub is unavailable in this build of Trace.");
    }
  }

  #assertSecureStorage() {
    if (
      !this.#safeStorage ||
      typeof this.#safeStorage.encryptString !== "function" ||
      typeof this.#safeStorage.decryptString !== "function" ||
      (typeof this.#safeStorage.isEncryptionAvailable === "function" && !this.#safeStorage.isEncryptionAvailable()) ||
      typeof this.#settingsPath !== "string" ||
      this.#settingsPath.length === 0
    ) throw githubError(
      "GITHUB_SECURE_STORAGE_UNAVAILABLE",
      "Secure credential storage is unavailable, so Trace will not save GitHub access.",
    );
  }

  #flow(value) {
    const flowId = requiredString(value, "device-flow identity", 256);
    const flow = this.#flows.get(flowId);
    if (!flow) throw githubError("GITHUB_DEVICE_FLOW_NOT_FOUND", "This GitHub sign-in attempt is no longer active.");
    return flow;
  }

  async #repository(workspaceId) {
    if (!this.#workspaceManager || typeof this.#workspaceManager.getExecutionContext !== "function") {
      throw githubError("GITHUB_UNAVAILABLE", "The GitHub workspace service is unavailable.");
    }
    this.#workspaceManager.getExecutionContext(workspaceId);
    if (!this.#gitManager || typeof this.#gitManager.getGitHubRepository !== "function") {
      throw githubError("GITHUB_UNAVAILABLE", "The GitHub repository service is unavailable.");
    }
    const repository = validateGitHubRepository(
      await this.#gitManager.getGitHubRepository({ workspaceId }),
      workspaceId,
    );
    this.#workspaceManager.getExecutionContext(workspaceId);
    return repository;
  }

  async #assertFlowWorkspace(flow) {
    try {
      await this.#assertRepositoryUnchanged(flow.repository);
    } catch {
      this.#flows.delete(flow.flowId);
      throw new WorkspaceError("WORKSPACE_CHANGED", "The workspace repository changed before GitHub sign-in finished.");
    }
  }

  async #assertRepositoryUnchanged(expectedRepository) {
    let current;
    try {
      current = await this.#repository(expectedRepository.workspaceId);
    } catch {
      throw new WorkspaceError("WORKSPACE_CHANGED", "The workspace repository changed before GitHub could finish.");
    }
    if (
      current.fullName.toLowerCase() !== expectedRepository.fullName.toLowerCase() ||
      current.localRepositoryKey !== expectedRepository.localRepositoryKey
    ) {
      throw new WorkspaceError("WORKSPACE_CHANGED", "The workspace repository changed before GitHub could finish.");
    }
  }

  #matchingConnection(workspaceId, repository) {
    const connection = this.#connections.get(workspaceId);
    if (
      !connection ||
      connection.repository.fullName.toLowerCase() !== repository.fullName.toLowerCase() ||
      connection.repository.localRepositoryKey !== repository.localRepositoryKey
    ) return null;
    return connection;
  }

  #publicState(repository, connection) {
    const tokenExpired = Boolean(connection && connection.tokens.expiresAt !== null &&
      connection.tokens.expiresAt <= this.#now() && (
        !connection.tokens.refreshToken ||
        (connection.tokens.refreshExpiresAt !== null && connection.tokens.refreshExpiresAt <= this.#now())
      ));
    const configured = typeof this.#clientId === "string" && this.#clientId.length > 0;
    const effectiveRepository = connection
      ? { ...repository, defaultBranch: connection.repository.defaultBranch ?? repository.defaultBranch }
      : repository;
    const status = tokenExpired
      ? "expired"
      : connection
        ? "connected"
        : configured
          ? "disconnected"
          : "config-required";
    return {
      workspaceId: repository.workspaceId,
      status,
      repository: publicRepository(effectiveRepository),
      account: publicAccount(connection?.account),
      message: tokenExpired
        ? "GitHub access expired. Connect this workspace again."
        : status === "config-required"
          ? "GitHub sign-in is not configured in this build of Trace."
          : null,
      installationUrl: `https://github.com/apps/${this.#appSlug}/installations/new`,
      lastSyncedAt: null,
      hasCachedData: false,
    };
  }

  async #oauthRequest(body) {
    this.#assertConfigured();
    const isDeviceStart = !body.has("device_code") && !body.has("refresh_token") && !body.has("grant_type");
    const url = isDeviceStart ? DEVICE_CODE_URL : ACCESS_TOKEN_URL;
    const response = await this.#fetchResponse(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": this.#appSlug,
      },
      body: body.toString(),
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      throw githubError("GITHUB_SERVICE_UNAVAILABLE", "GitHub sign-in is temporarily unavailable.");
    }
    return this.#readJson(response, DEFAULT_MAX_OUTPUT_BYTES);
  }

  async #requestWithToken(accessToken, apiPath, { method = "GET", body } = {}, expectedRepository) {
    const response = await this.#fetchResponse(`${API_ORIGIN}${apiPath}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": this.#appSlug,
        "X-GitHub-Api-Version": API_VERSION,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
    });
    try {
      await this.#assertRepositoryUnchanged(expectedRepository);
    } catch (error) {
      await response.body?.cancel?.().catch(() => {});
      throw error;
    }
    const rateLimit = parseRateLimit(response.headers);
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      throw this.#responseError(response.status, rateLimit);
    }
    return { data: await this.#readJson(response, DEFAULT_MAX_OUTPUT_BYTES), rateLimit };
  }

  async #apiRequest(repository, apiPath, options = {}) {
    let connection = await this.#connectionFor(repository);
    connection = await this.#refreshIfNeeded(connection, false);
    try {
      return await this.#requestWithToken(connection.tokens.accessToken, apiPath, options, repository);
    } catch (error) {
      if (!(error instanceof WorkspaceError) || error.code !== "AUTH_EXPIRED") throw error;
    }
    connection = await this.#refreshIfNeeded(connection, true);
    try {
      return await this.#requestWithToken(connection.tokens.accessToken, apiPath, options, repository);
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === "AUTH_EXPIRED") {
        await this.#removeConnection(repository.workspaceId);
      }
      throw error;
    }
  }

  async #connectionFor(repository) {
    await this.#ensureLoaded();
    const connection = this.#matchingConnection(repository.workspaceId, repository);
    if (!connection) {
      throw githubError("GITHUB_NOT_CONNECTED", "Connect this workspace to GitHub before opening pull requests or issues.");
    }
    return connection;
  }

  async #refreshIfNeeded(connection, force) {
    const expiresAt = connection.tokens.expiresAt;
    if (!force && (expiresAt === null || expiresAt > this.#now() + REFRESH_WINDOW_MS)) return connection;
    const existing = this.#refreshes.get(connection.workspaceId);
    if (existing) return existing;
    const refresh = this.#refreshConnection(connection).finally(() => {
      if (this.#refreshes.get(connection.workspaceId) === refresh) this.#refreshes.delete(connection.workspaceId);
    });
    this.#refreshes.set(connection.workspaceId, refresh);
    return refresh;
  }

  async #refreshConnection(connection) {
    const refreshToken = connection.tokens.refreshToken;
    if (!refreshToken || (
      connection.tokens.refreshExpiresAt !== null && connection.tokens.refreshExpiresAt <= this.#now()
    )) {
      await this.#removeConnection(connection.workspaceId);
      throw githubError("AUTH_EXPIRED", "GitHub access expired. Connect this workspace again.");
    }
    let data;
    try {
      data = await this.#oauthRequest(new URLSearchParams({
        client_id: this.#clientId,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }));
    } catch (error) {
      if (error instanceof WorkspaceError && ["GITHUB_OFFLINE", "GITHUB_TIMEOUT"].includes(error.code)) throw error;
      await this.#removeConnection(connection.workspaceId);
      throw githubError("AUTH_EXPIRED", "GitHub access expired. Connect this workspace again.");
    }
    await this.#assertRepositoryUnchanged(connection.repository);
    if (data?.error) {
      await this.#removeConnection(connection.workspaceId);
      throw githubError("AUTH_EXPIRED", "GitHub access expired. Connect this workspace again.");
    }
    const tokens = tokenRecord(data, this.#now());
    if (!tokens.refreshToken) {
      tokens.refreshToken = refreshToken;
      tokens.refreshExpiresAt = connection.tokens.refreshExpiresAt;
    }
    const updated = { ...connection, tokens };
    await this.#mutateConnections(async () => {
      const current = this.#connections.get(connection.workspaceId);
      if (current === connection || current?.tokens.accessToken === connection.tokens.accessToken) {
        this.#connections.set(connection.workspaceId, updated);
      }
    });
    const active = this.#connections.get(connection.workspaceId);
    if (!active) {
      throw githubError("GITHUB_NOT_CONNECTED", "Connect this workspace to GitHub before opening pull requests or issues.");
    }
    return active;
  }

  async #removeConnection(workspaceId) {
    await this.#mutateConnections(async () => {
      this.#connections.delete(workspaceId);
    });
  }

  #responseError(status, rateLimit) {
    if (status === 401) {
      return githubError("AUTH_EXPIRED", "GitHub access expired. Connect this workspace again.");
    }
    if (status === 429 || (status === 403 && rateLimit?.remaining === 0)) {
      return githubError(
        "GITHUB_RATE_LIMIT",
        "GitHub's request limit has been reached. Try again after it resets.",
        { rateLimit },
      );
    }
    if (status === 404) {
      return githubError(
        "INSTALLATION_REQUIRED",
        "The GitHub App cannot access this repository or item. Install it for the repository and check its permissions.",
      );
    }
    if (status === 403) {
      return githubError(
        "GITHUB_PERMISSION_DENIED",
        "The GitHub App does not have permission for this action. Check its repository permissions.",
      );
    }
    return githubError("GITHUB_SERVICE_UNAVAILABLE", "GitHub is temporarily unavailable. Try again shortly.");
  }

  async #readReviewThreads(repository, number, headOid) {
    const threads = [];
    let cursor = null;
    let truncated = false;
    let rateLimit = null;
    for (let pageIndex = 0; pageIndex < MAX_REVIEW_THREAD_PAGES; pageIndex += 1) {
      const response = await this.#apiRequest(repository, "/graphql", {
        method: "POST",
        body: {
          query: REVIEW_THREADS_QUERY,
          variables: { owner: repository.owner, name: repository.name, number, after: cursor },
        },
      });
      if (Array.isArray(response.data?.errors) && response.data.errors.length > 0) {
        throw githubError("GITHUB_PERMISSION_DENIED", "GitHub could not read review threads for this pull request.");
      }
      const connection = response.data?.data?.repository?.pullRequest?.reviewThreads;
      if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo) {
        throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned data that Trace could not safely read.");
      }
      threads.push(...normalizeReviewThreads(connection.nodes, headOid));
      const graphRate = response.data?.data?.rateLimit;
      if (graphRate && typeof graphRate === "object") {
        rateLimit = {
          limit: safeInteger(graphRate.limit),
          remaining: safeInteger(graphRate.remaining),
          used: safeInteger(graphRate.used),
          resetAt: safeDate(graphRate.resetAt),
          resource: safeText(graphRate.resource, { maximum: 64 }),
        };
      }
      const reviewDecisionValue = response.data?.data?.repository?.pullRequest?.reviewDecision;
      const reviewDecision = reviewDecisionValue === "APPROVED"
        ? "approved"
        : reviewDecisionValue === "CHANGES_REQUESTED"
          ? "changes-requested"
          : reviewDecisionValue === "REVIEW_REQUIRED"
            ? "review-required"
            : null;
      if (!connection.pageInfo.hasNextPage) return { threads, truncated, rateLimit, reviewDecision };
      cursor = safeText(connection.pageInfo.endCursor, { required: true, maximum: 2_048 });
      if (pageIndex === MAX_REVIEW_THREAD_PAGES - 1) truncated = true;
    }
    return { threads, truncated, rateLimit, reviewDecision: null };
  }

  async #fetchResponse(url, options) {
    this.#assertConfigured();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const response = await this.#fetch(url, { ...options, signal: controller.signal });
      if (
        !response ||
        typeof response !== "object" ||
        typeof response.ok !== "boolean" ||
        !Number.isInteger(response.status) ||
        typeof response.arrayBuffer !== "function" &&
        typeof response.body?.getReader !== "function"
      ) throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned data that Trace could not safely read.");
      return response;
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      if (error?.name === "AbortError" || controller.signal.aborted) {
        throw githubError("GITHUB_TIMEOUT", "GitHub took too long to respond.");
      }
      throw githubError("GITHUB_OFFLINE", "GitHub could not be reached. Check the connection and try again.");
    } finally {
      clearTimeout(timeout);
    }
  }

  async #readJson(response, maxBytes) {
    const contentLength = response.headers?.get?.("content-length");
    if (contentLength && /^\d+$/.test(contentLength) && Number.parseInt(contentLength, 10) > maxBytes) {
      await response.body?.cancel?.().catch(() => {});
      throw githubError("GITHUB_OUTPUT_LIMIT", "GitHub returned more data than Trace can safely display.");
    }
    let buffer;
    if (typeof response.body?.getReader === "function") {
      let reader;
      const chunks = [];
      let totalBytes = 0;
      try {
        reader = response.body.getReader();
        while (true) {
          const result = await reader.read();
          if (!result || typeof result !== "object" || typeof result.done !== "boolean") {
            throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned data that Trace could not safely read.");
          }
          if (result.done) break;
          const value = result.value;
          if (!ArrayBuffer.isView(value)) {
            throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned data that Trace could not safely read.");
          }
          if (value.byteLength > maxBytes - totalBytes) {
            await reader.cancel().catch(() => {});
            throw githubError("GITHUB_OUTPUT_LIMIT", "GitHub returned more data than Trace can safely display.");
          }
          const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
          chunks.push(Buffer.from(chunk));
          totalBytes += value.byteLength;
        }
        buffer = Buffer.concat(chunks, totalBytes);
      } catch (error) {
        await reader?.cancel?.().catch(() => {});
        if (error instanceof WorkspaceError) throw error;
        throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned data that Trace could not safely read.");
      } finally {
        try {
          reader?.releaseLock?.();
        } catch {
          // The body has already been consumed or cancelled; do not expose stream implementation errors.
        }
      }
    } else {
      if (!contentLength || !/^\d+$/.test(contentLength)) {
        throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned an unbounded response that Trace could not safely read.");
      }
      try {
        buffer = Buffer.from(await response.arrayBuffer());
      } catch {
        throw githubError("GITHUB_INVALID_RESPONSE", "GitHub returned data that Trace could not safely read.");
      }
      if (buffer.length > maxBytes) {
        throw githubError("GITHUB_OUTPUT_LIMIT", "GitHub returned more data than Trace can safely display.");
      }
    }
    return parseJsonBuffer(buffer);
  }

  async #ensureLoaded() {
    if (!this.#loaded) this.#loaded = this.#loadConnections();
    return this.#loaded;
  }

  async #loadConnections() {
    if (typeof this.#settingsPath !== "string" || this.#settingsPath.length === 0) return;
    let buffer;
    try {
      const stats = await fsp.stat(this.#settingsPath);
      if (!stats.isFile() || stats.size > MAX_SETTINGS_BYTES) {
        throw githubError("GITHUB_SETTINGS_INVALID", "Saved GitHub credentials could not be safely read.");
      }
      buffer = await fsp.readFile(this.#settingsPath);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      if (error instanceof WorkspaceError) throw error;
      throw githubError("GITHUB_SETTINGS_INVALID", "Saved GitHub credentials could not be safely read.");
    }
    let state;
    try {
      state = JSON.parse(buffer.toString("utf8"));
    } catch {
      throw githubError("GITHUB_SETTINGS_INVALID", "Saved GitHub credentials could not be safely read.");
    }
    if (state?.version !== 1 || !Array.isArray(state.connections) || state.connections.length > 1_000) {
      throw githubError("GITHUB_SETTINGS_INVALID", "Saved GitHub credentials could not be safely read.");
    }
    if (state.connections.length > 0) this.#assertSecureStorage();
    for (const stored of state.connections) {
      try {
        const workspaceId = requiredString(stored.workspaceId, "workspace identity");
        const repository = validateGitHubRepository(stored.repository, workspaceId);
        const encrypted = Buffer.from(requiredString(stored.encryptedTokens, "encrypted credentials", 256 * 1024), "base64");
        if (encrypted.length === 0 || encrypted.length > 128 * 1024) throw new Error("invalid");
        const decrypted = this.#safeStorage.decryptString(encrypted);
        const rawTokens = JSON.parse(decrypted);
        const tokens = this.#storedTokens(rawTokens);
        const account = normalizeUser(stored.account);
        if (!account) throw new Error("invalid");
        this.#connections.set(workspaceId, {
          workspaceId,
          repository,
          account,
          tokens,
          connectedAt: safeDate(stored.connectedAt) ?? new Date(0).toISOString(),
        });
      } catch (error) {
        if (error instanceof WorkspaceError && error.code === "GITHUB_SECURE_STORAGE_UNAVAILABLE") throw error;
        throw githubError("GITHUB_SETTINGS_INVALID", "Saved GitHub credentials could not be safely read.");
      }
    }
  }

  #storedTokens(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    const accessToken = safeText(value.accessToken, { required: true, maximum: MAX_TOKEN_BYTES });
    const refreshToken = safeText(value.refreshToken, { maximum: MAX_TOKEN_BYTES });
    const timestamp = (input) => input === null ? null : Number.isFinite(input) && input >= 0 ? input : (() => { throw new Error("invalid"); })();
    return {
      accessToken,
      refreshToken,
      expiresAt: timestamp(value.expiresAt),
      refreshExpiresAt: timestamp(value.refreshExpiresAt),
      scopes: Array.isArray(value.scopes)
        ? value.scopes.map((scope) => safeText(scope, { required: true, maximum: 512 })).slice(0, 100)
        : [],
      tokenType: safeText(value.tokenType, { maximum: 64 }) ?? "bearer",
    };
  }

  async #mutateConnections(mutation) {
    const operation = this.#storeTail.then(async () => {
      await this.#ensureLoaded();
      const previous = new Map(this.#connections);
      try {
        await mutation();
        await this.#persistConnections();
      } catch (error) {
        this.#connections = previous;
        throw error;
      }
    }, async () => {
      await this.#ensureLoaded();
      const previous = new Map(this.#connections);
      try {
        await mutation();
        await this.#persistConnections();
      } catch (error) {
        this.#connections = previous;
        throw error;
      }
    });
    this.#storeTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #persistConnections() {
    this.#assertSecureStorage();
    const connections = [];
    for (const connection of this.#connections.values()) {
      const encrypted = this.#safeStorage.encryptString(JSON.stringify(connection.tokens));
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0 || encrypted.length > 128 * 1024) {
        throw githubError("GITHUB_SECURE_STORAGE_UNAVAILABLE", "Secure credential storage could not save GitHub access.");
      }
      connections.push({
        workspaceId: connection.workspaceId,
        repository: {
          ...publicRepository(connection.repository),
          localRepositoryKey: connection.repository.localRepositoryKey,
        },
        account: publicAccount(connection.account),
        connectedAt: connection.connectedAt,
        encryptedTokens: encrypted.toString("base64"),
      });
    }
    const contents = Buffer.from(JSON.stringify({ version: 1, connections }), "utf8");
    if (contents.length > MAX_SETTINGS_BYTES) {
      throw githubError("GITHUB_SETTINGS_INVALID", "Saved GitHub credentials are too large.");
    }
    const directory = path.dirname(this.#settingsPath);
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    const suffix = requiredString(this.#randomUUID(), "settings identity", 256).replace(/[^A-Za-z0-9-]/g, "");
    const temporaryPath = `${this.#settingsPath}.tmp-${process.pid}-${suffix}`;
    let handle;
    try {
      handle = await fsp.open(temporaryPath, "wx", 0o600);
      await handle.writeFile(contents);
      await handle.sync();
      await handle.close();
      handle = null;
      await fsp.rename(temporaryPath, this.#settingsPath);
      await fsp.chmod(this.#settingsPath, 0o600);
    } catch {
      await handle?.close().catch(() => {});
      await fsp.unlink(temporaryPath).catch(() => {});
      throw githubError("GITHUB_SETTINGS_WRITE_FAILED", "Trace could not securely save GitHub access.");
    }
  }
}

module.exports = {
  ACCESS_TOKEN_URL,
  API_ORIGIN,
  API_VERSION,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  DEVICE_CODE_URL,
  GitHubManager,
  MAX_REVIEW_THREAD_PAGES,
  REVIEW_THREADS_QUERY,
  normalizeIssue,
  normalizePullRequest,
  normalizeReviewThreads,
  normalizeUser,
  parseRateLimit,
  validateGitHubRepository,
};
