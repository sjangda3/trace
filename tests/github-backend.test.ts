import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  API_VERSION,
  GitHubManager,
  normalizeIssue,
  normalizePullRequest,
  normalizeReviewThreads,
  parseRateLimit,
  validateGitHubRepository,
} = require("../electron/github.cjs") as Record<string, any>;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

class FakeWorkspaceManager {
  workspaceId = "workspace-1";
  rootPath = "/workspace";

  getExecutionContext(workspaceId: string) {
    if (workspaceId !== this.workspaceId) {
      const error = new Error("The workspace changed.") as Error & { code: string };
      error.code = "WORKSPACE_CHANGED";
      throw error;
    }
    return { workspaceId, rootPath: this.rootPath };
  }
}

class FakeGitManager {
  repository = {
    workspaceId: "workspace-1",
    localRepositoryKey: "/workspace/.git",
    headOid: "a".repeat(40),
    currentBranch: "main",
    remoteName: "origin",
    provider: "github",
    host: "github.com",
    owner: "octo-org",
    repository: "trace",
    fullName: "octo-org/trace",
  };

  async getGitHubRepository() {
    return this.repository;
  }
}

class FakeSafeStorage {
  isEncryptionAvailable() { return true; }

  encryptString(value: string) {
    return Buffer.from(value, "utf8").map((byte) => byte ^ 0xa5);
  }

  decryptString(value: Buffer) {
    return Buffer.from(value).map((byte) => byte ^ 0xa5).toString("utf8");
  }
}

type FetchCall = { url: string; init: RequestInit };

class FetchQueue {
  calls: FetchCall[] = [];
  handlers: Array<(url: string, init: RequestInit) => Promise<Response> | Response> = [];

  enqueueJson(value: unknown, status = 200, headers: Record<string, string> = {}) {
    this.handlers.push(() => jsonResponse(value, status, headers));
  }

  fetch = async (url: string | URL, init: RequestInit = {}) => {
    const stringUrl = String(url);
    this.calls.push({ url: stringUrl, init });
    const handler = this.handlers.shift();
    if (!handler) throw new Error(`Unexpected fetch: ${stringUrl}`);
    return handler(stringUrl, init);
  };
}

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function user(login = "octocat") {
  return {
    id: 1,
    login,
    name: "Octo Cat",
    avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
    html_url: `https://github.com/${login}`,
  };
}

function pullRequest(number = 7) {
  return {
    id: 100 + number,
    number,
    title: "Review collaborative editor",
    body: "Written context",
    state: "open",
    draft: false,
    user: user(),
    created_at: "2026-07-12T10:00:00Z",
    updated_at: "2026-07-13T10:00:00Z",
    html_url: `https://github.com/octo-org/trace/pull/${number}`,
    head: { ref: "feature/review", sha: "b".repeat(40), label: "octo:feature/review" },
    base: { ref: "main", sha: "a".repeat(40), label: "octo:main" },
    requested_reviewers: [user("reviewer")],
    labels: [{ id: 2, name: "editor", color: "abcdef" }],
    comments: 2,
    review_comments: 3,
    changed_files: 1,
    additions: 10,
    deletions: 2,
    mergeable: true,
  };
}

function issue(number = 4) {
  return {
    id: 200 + number,
    number,
    title: "Terminal control ticket",
    body: "Only one writer",
    state: "open",
    user: user(),
    assignees: [user()],
    labels: [{ id: 3, name: "terminal", color: "123456" }],
    comments: 1,
    created_at: "2026-07-11T10:00:00Z",
    updated_at: "2026-07-13T11:00:00Z",
    html_url: `https://github.com/octo-org/trace/issues/${number}`,
  };
}

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trace-github-"));
  temporaryDirectories.push(directory);
  const queue = new FetchQueue();
  const workspaceManager = new FakeWorkspaceManager();
  const gitManager = new FakeGitManager();
  const safeStorage = new FakeSafeStorage();
  let currentTime = Date.parse("2026-07-13T12:00:00Z");
  let uuid = 0;
  const opened: string[] = [];
  const options = {
    workspaceManager,
    gitManager,
    fetchImpl: queue.fetch,
    safeStorage,
    settingsPath: path.join(directory, "github.json"),
    clientId: "Iv1.public-client-id",
    appSlug: "trace-test",
    shell: { openExternal: async (url: string) => { opened.push(url); } },
    now: () => currentTime,
    randomUUID: () => `uuid-${++uuid}`,
  };
  const manager = new GitHubManager(options);
  return {
    manager,
    options,
    queue,
    workspaceManager,
    gitManager,
    safeStorage,
    opened,
    settingsPath: options.settingsPath,
    now: () => currentTime,
    advance: (milliseconds: number) => { currentTime += milliseconds; },
  };
}

async function begin(manager: any, queue: FetchQueue, interval = 5) {
  queue.enqueueJson({
    device_code: "private-device-code",
    user_code: "ABCD-EFGH",
    verification_uri: "https://github.com/login/device",
    expires_in: 900,
    interval,
  });
  return manager.beginDeviceFlow({ workspaceId: "workspace-1" });
}

async function connect(manager: any, queue: FetchQueue, token: Record<string, unknown> = {}) {
  const flow = await begin(manager, queue);
  queue.enqueueJson({
    access_token: "ghu_private-access-token",
    refresh_token: "ghr_private-refresh-token",
    expires_in: 28_800,
    refresh_token_expires_in: 15_552_000,
    scope: "repo read:user",
    token_type: "bearer",
    ...token,
  });
  queue.enqueueJson(user());
  queue.enqueueJson({ id: 99, default_branch: "trunk" });
  const result = await manager.pollDeviceFlow({ workspaceId: "workspace-1", flowId: flow.flowId });
  expect(result.status).toBe("connected");
  return { flow, result };
}

async function thrownBy(action: () => Promise<unknown>) {
  try {
    await action();
    throw new Error("Expected action to fail.");
  } catch (error) {
    return error as Error & { code?: string; rateLimit?: unknown };
  }
}

describe("GitHub normalization", () => {
  it("normalizes repositories, pull requests, issues, review anchors, and rate limits", () => {
    expect(validateGitHubRepository(new FakeGitManager().repository, "workspace-1")).toMatchObject({
      fullName: "octo-org/trace",
      defaultBranch: "main",
      headOid: "a".repeat(40),
    });
    expect(normalizePullRequest(pullRequest())).toMatchObject({
      number: 7,
      state: "open",
      headRefName: "feature/review",
      headOid: "b".repeat(40),
      commentCount: 5,
      labels: [{ id: "2", name: "editor", color: "abcdef" }],
    });
    expect(normalizeIssue(issue(), "octocat")).toMatchObject({ assignedToViewer: true, commentCount: 1 });
    const threads = normalizeReviewThreads([{
      id: "PRRT_1",
      isResolved: false,
      isOutdated: false,
      path: "src/editor.ts",
      line: 24,
      startLine: 22,
      diffSide: "RIGHT",
      comments: {
        totalCount: 1,
        nodes: [{
          id: "PRRC_1",
          body: "Keep this synchronized.",
          author: { login: "reviewer", avatarUrl: null, url: "https://github.com/reviewer" },
          createdAt: "2026-07-13T10:00:00Z",
          updatedAt: "2026-07-13T10:00:00Z",
          url: "https://github.com/octo-org/trace/pull/7#discussion_r1",
          diffHunk: "@@ -20,5 +20,7 @@",
          commit: { oid: "b".repeat(40) },
        }],
      },
    }], "b".repeat(40));
    expect(threads[0]).toMatchObject({
      anchor: { path: "src/editor.ts", startLine: 22, endLine: 24, side: "RIGHT", commitOid: "b".repeat(40) },
    });
    expect(parseRateLimit(new Headers({
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "42",
      "x-ratelimit-reset": "1783976400",
    }))).toMatchObject({ limit: 5000, remaining: 42 });
  });
});

describe("GitHub App device flow", () => {
  it("never exposes the device code and enforces pending and slow-down intervals", async () => {
    const { manager, queue, advance } = await fixture();
    const flow = await begin(manager, queue, 5);
    expect(flow).toEqual(expect.objectContaining({
      flowId: "uuid-1",
      userCode: "ABCD-EFGH",
      retryAfterSeconds: 5,
    }));
    expect(JSON.stringify(flow)).not.toContain("private-device-code");

    queue.enqueueJson({ error: "authorization_pending" });
    expect(await manager.pollDeviceFlow({ workspaceId: "workspace-1", flowId: flow.flowId })).toMatchObject({
      status: "pending",
      retryAfterSeconds: 5,
    });
    const callsAfterPoll = queue.calls.length;
    expect(await manager.pollDeviceFlow({ workspaceId: "workspace-1", flowId: flow.flowId })).toMatchObject({ status: "pending" });
    expect(queue.calls).toHaveLength(callsAfterPoll);

    advance(5_000);
    queue.enqueueJson({ error: "slow_down" });
    expect(await manager.pollDeviceFlow({ workspaceId: "workspace-1", flowId: flow.flowId })).toMatchObject({
      status: "slow-down",
      retryAfterSeconds: 10,
    });
  });

  it("opens only the server-provided GitHub device page and cancellation returns workspace state", async () => {
    const { manager, queue, opened } = await fixture();
    const flow = await begin(manager, queue);
    await expect(manager.openDeviceFlow({ workspaceId: "workspace-1", flowId: flow.flowId })).resolves.toEqual({ opened: true });
    expect(opened).toEqual(["https://github.com/login/device"]);
    await expect(manager.cancelDeviceFlow({ workspaceId: "workspace-1", flowId: flow.flowId })).resolves.toMatchObject({
      workspaceId: "workspace-1",
      status: "disconnected",
    });
  });

  it("validates the user and repository, persists only encrypted tokens in a 0600 atomic file, and reloads state", async () => {
    const { manager, options, queue, settingsPath } = await fixture();
    const { result } = await connect(manager, queue);
    expect(result.state).toMatchObject({
      workspaceId: "workspace-1",
      status: "connected",
      account: { login: "octocat", name: "Octo Cat" },
      repository: {
        fullName: "octo-org/trace",
        defaultBranch: "trunk",
        headOid: "a".repeat(40),
        currentBranch: "main",
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/gh[ur]_private/);
    const saved = await readFile(settingsPath, "utf8");
    expect(saved).not.toContain("ghu_private-access-token");
    expect(saved).not.toContain("ghr_private-refresh-token");
    expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);

    const restored = new GitHubManager({ ...options, fetchImpl: async () => { throw new Error("no network expected"); } });
    await expect(restored.getState({ workspaceId: "workspace-1" })).resolves.toMatchObject({
      status: "connected",
      account: { login: "octocat" },
      repository: { defaultBranch: "trunk" },
    });
  });

  it("uses a secretless refresh grant before an expiring token is sent", async () => {
    const { manager, queue } = await fixture();
    await connect(manager, queue, { expires_in: 60 });
    queue.enqueueJson({
      access_token: "ghu_refreshed-token",
      refresh_token: "ghr_rotated-token",
      expires_in: 28_800,
      refresh_token_expires_in: 15_552_000,
      token_type: "bearer",
    });
    queue.enqueueJson([pullRequest()]);
    const result = await manager.listPullRequests({ workspaceId: "workspace-1" });
    expect(result.items).toHaveLength(1);
    const refreshCall = queue.calls.find((call) => String(call.init.body).includes("grant_type=refresh_token"));
    expect(refreshCall).toBeDefined();
    expect(String(refreshCall!.init.body)).not.toContain("client_secret");
    const apiCall = queue.calls.at(-1)!;
    expect((apiCall.init.headers as Record<string, string>).Authorization).toBe("Bearer ghu_refreshed-token");
  });

  it("refreshes once after a 401 and does not retry with the rejected token", async () => {
    const { manager, queue } = await fixture();
    await connect(manager, queue);
    queue.enqueueJson({ message: "Bad credentials" }, 401);
    queue.enqueueJson({
      access_token: "ghu_after-401",
      refresh_token: "ghr_after-401",
      expires_in: 28_800,
      refresh_token_expires_in: 15_552_000,
      token_type: "bearer",
    });
    queue.enqueueJson([pullRequest()]);
    await expect(manager.listPullRequests({ workspaceId: "workspace-1" })).resolves.toMatchObject({
      items: [{ number: 7 }],
    });
    const authorizationHeaders = queue.calls
      .filter((call) => call.url.includes("api.github.com/repos") && call.url.includes("/pulls?"))
      .map((call) => (call.init.headers as Record<string, string>).Authorization);
    expect(authorizationHeaders).toEqual(["Bearer ghu_private-access-token", "Bearer ghu_after-401"]);
  });

  it("expires a device flow locally without polling GitHub again", async () => {
    const { manager, queue, advance } = await fixture();
    const flow = await begin(manager, queue);
    const callCount = queue.calls.length;
    advance(901_000);
    await expect(manager.pollDeviceFlow({ workspaceId: "workspace-1", flowId: flow.flowId })).resolves.toEqual({
      status: "expired",
      retryAfterSeconds: 0,
      message: "The GitHub authorization code expired.",
      state: null,
    });
    expect(queue.calls).toHaveLength(callCount);
  });
});

describe("GitHub repository reads", () => {
  it.each([
    {
      label: "opaque local repository identity",
      mutate: (repository: Record<string, unknown>) => ({
        ...repository,
        localRepositoryKey: "/workspace/.git-replaced",
      }),
      responseStatus: 200,
    },
    {
      label: "GitHub repository name",
      mutate: (repository: Record<string, unknown>) => ({
        ...repository,
        owner: "another-org",
        repository: "another-repo",
        fullName: "another-org/another-repo",
      }),
      responseStatus: 404,
    },
  ])("discards an authenticated response when the $label changes in flight", async ({ mutate, responseStatus }) => {
    const { manager, queue, gitManager } = await fixture();
    await connect(manager, queue);
    queue.handlers.push(() => {
      gitManager.repository = mutate(gitManager.repository) as typeof gitManager.repository;
      return jsonResponse(responseStatus === 200 ? [pullRequest()] : { message: "Not Found" }, responseStatus);
    });
    await expect(thrownBy(() => manager.listPullRequests({ workspaceId: "workspace-1" }))).resolves.toMatchObject({
      code: "WORKSPACE_CHANGED",
      message: "The workspace repository changed before GitHub could finish.",
    });
  });

  it("stops reading a streaming response as soon as the incremental byte cap is crossed", async () => {
    const { manager, queue } = await fixture();
    await connect(manager, queue);
    const chunks = [
      new Uint8Array(3 * 1024 * 1024),
      new Uint8Array(2 * 1024 * 1024),
      new Uint8Array(1),
    ];
    let reads = 0;
    let cancelled = false;
    queue.handlers.push(() => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => reads < chunks.length
            ? { done: false, value: chunks[reads++] }
            : { done: true, value: undefined },
          cancel: async () => { cancelled = true; },
          releaseLock: () => {},
        }),
      },
    } as unknown as Response));
    await expect(thrownBy(() => manager.listIssues({ workspaceId: "workspace-1" }))).resolves.toMatchObject({
      code: "GITHUB_OUTPUT_LIMIT",
    });
    expect(reads).toBe(2);
    expect(cancelled).toBe(true);
  });

  it("uses arrayBuffer only for a bounded non-streaming test double", async () => {
    const { manager, queue } = await fixture();
    await connect(manager, queue);
    let unboundedRead = false;
    queue.handlers.push(() => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: null,
      arrayBuffer: async () => {
        unboundedRead = true;
        return new ArrayBuffer(0);
      },
    } as unknown as Response));
    await expect(thrownBy(() => manager.listIssues({ workspaceId: "workspace-1" }))).resolves.toMatchObject({
      code: "GITHUB_INVALID_RESPONSE",
    });
    expect(unboundedRead).toBe(false);

    const encoded = new TextEncoder().encode(JSON.stringify([issue()]));
    queue.handlers.push(() => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": String(encoded.byteLength) }),
      body: null,
      arrayBuffer: async () => encoded.buffer,
    } as unknown as Response));
    await expect(manager.listIssues({ workspaceId: "workspace-1" })).resolves.toMatchObject({
      items: [{ number: 4 }],
    });
  });

  it("lists normalized pull requests and issues through fixed API endpoints and versioned headers", async () => {
    const { manager, queue } = await fixture();
    await connect(manager, queue);
    queue.enqueueJson([pullRequest()]);
    const pulls = await manager.listPullRequests({ workspaceId: "workspace-1" });
    expect(pulls).toMatchObject({ cached: false, stale: false, items: [{ number: 7, headRefName: "feature/review" }] });
    queue.enqueueJson([issue(), { ...pullRequest(), pull_request: { url: "https://api.github.com/pulls/7" } }]);
    const issues = await manager.listIssues({ workspaceId: "workspace-1" });
    expect(issues.items).toHaveLength(1);
    expect(issues.items[0]).toMatchObject({ number: 4, assignedToViewer: true });

    const readCalls = queue.calls.filter((call) => call.url.startsWith("https://api.github.com/repos/"));
    expect(readCalls.some((call) => call.url.includes("/pulls?"))).toBe(true);
    expect(readCalls.some((call) => call.url.includes("/issues?"))).toBe(true);
    for (const call of readCalls) {
      expect((call.init.headers as Record<string, string>)["X-GitHub-Api-Version"]).toBe(API_VERSION);
    }
  });

  it("loads pull-request review threads, files, checks, and issue comments", async () => {
    const { manager, queue } = await fixture();
    await connect(manager, queue);
    queue.enqueueJson(pullRequest());
    queue.enqueueJson({ data: {
      repository: { pullRequest: {
        reviewDecision: "APPROVED",
        reviewThreads: {
          nodes: [{
            id: "PRRT_1",
            isResolved: false,
            isOutdated: false,
            path: "src/editor.ts",
            line: 24,
            startLine: 24,
            diffSide: "RIGHT",
            comments: { totalCount: 1, nodes: [{
              id: "PRRC_1",
              body: "Looks good.",
              author: { login: "reviewer", url: "https://github.com/reviewer" },
              createdAt: "2026-07-13T10:00:00Z",
              updatedAt: "2026-07-13T10:00:00Z",
              url: "https://github.com/octo-org/trace/pull/7#discussion_r1",
              commit: { oid: "b".repeat(40) },
              diffHunk: "@@ -24 +24 @@",
            }] },
          }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      } },
      rateLimit: { limit: 5000, remaining: 4999, used: 1, resetAt: "2026-07-13T13:00:00Z", resource: "GRAPHQL" },
    } });
    queue.enqueueJson([{ filename: "src/editor.ts", status: "modified", additions: 10, deletions: 2 }]);
    queue.enqueueJson({ check_runs: [{ id: 8, name: "test", status: "completed", conclusion: "success", details_url: "https://github.com/octo/checks/8" }] });
    await expect(manager.getPullRequest({ workspaceId: "workspace-1", number: 7 })).resolves.toMatchObject({
      number: 7,
      reviewDecision: "approved",
      files: [{ path: "src/editor.ts", status: "changed" }],
      checks: [{ name: "test", status: "success" }],
      reviewThreads: [{ anchor: { path: "src/editor.ts", endLine: 24 } }],
    });

    queue.enqueueJson(issue());
    queue.enqueueJson([{
      id: 91,
      user: user("teammate"),
      body: "Confirmed.",
      created_at: "2026-07-13T10:00:00Z",
      updated_at: "2026-07-13T10:00:00Z",
      html_url: "https://github.com/octo-org/trace/issues/4#issuecomment-91",
    }]);
    await expect(manager.getIssue({ workspaceId: "workspace-1", number: 4 })).resolves.toMatchObject({
      number: 4,
      body: "Only one writer",
      comments: [{ author: { login: "teammate" }, body: "Confirmed." }],
    });
  });

  it("maps rate limits, installation permissions, offline failures, and output limits without leaking tokens", async () => {
    const { manager, queue } = await fixture();
    await connect(manager, queue);

    queue.handlers.push(() => jsonResponse({ message: "secret remote text" }, 403, {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-reset": "1783976400",
    }));
    const rate = await thrownBy(() => manager.listPullRequests({ workspaceId: "workspace-1" }));
    expect(rate).toMatchObject({ code: "GITHUB_RATE_LIMIT" });
    expect(rate.message).not.toContain("secret remote text");
    expect(JSON.stringify(rate)).not.toContain("ghu_private-access-token");

    queue.handlers.push(() => jsonResponse({ message: "Not Found" }, 404));
    expect(await thrownBy(() => manager.listIssues({ workspaceId: "workspace-1" }))).toMatchObject({
      code: "INSTALLATION_REQUIRED",
    });

    queue.handlers.push(() => { throw new TypeError("network included private data"); });
    expect(await thrownBy(() => manager.listIssues({ workspaceId: "workspace-1" }))).toMatchObject({
      code: "GITHUB_OFFLINE",
      message: "GitHub could not be reached. Check the connection and try again.",
    });

    queue.handlers.push(() => new Response("{}", {
      status: 200,
      headers: { "content-length": String(5 * 1024 * 1024) },
    }));
    expect(await thrownBy(() => manager.listIssues({ workspaceId: "workspace-1" }))).toMatchObject({
      code: "GITHUB_OUTPUT_LIMIT",
    });
  });
});
