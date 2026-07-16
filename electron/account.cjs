const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { WorkspaceError } = require("./workspace.cjs");

const MAX_SETTINGS_BYTES = 256 * 1024;
const MAX_INPUT_BYTES = 16 * 1024;
const MAX_URL_BYTES = 4 * 1024;

function accountError(code, message) {
  return new WorkspaceError(code, message);
}

function text(value, label, maximum = MAX_INPUT_BYTES) {
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value, "utf8") > maximum) {
    throw accountError("INVALID_REQUEST", `The ${label} is invalid.`);
  }
  return value;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw accountError("INVALID_REQUEST", `The ${label} is invalid.`);
  return value;
}

function publicUser(value) {
  const user = object(value, "account response");
  const id = text(user.id, "account identity", 128);
  const email = text(user.email, "account email", 254);
  const displayName = text(user.displayName, "account display name", 256);
  if (typeof user.emailVerified !== "boolean" || typeof user.githubLinked !== "boolean") {
    throw accountError("ACCOUNT_RESPONSE_INVALID", "Trace returned an invalid account response.");
  }
  return { id, email, displayName, emailVerified: user.emailVerified, githubLinked: user.githubLinked };
}

function controlPlaneUrl(raw) {
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { throw new Error("TRACE_CONTROL_PLANE_URL must be an absolute HTTPS URL."); }
  const local = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("TRACE_CONTROL_PLANE_URL must be an HTTPS origin without a path, query, or credentials.");
  }
  return url.toString().replace(/\/$/u, "");
}

class TraceAccountManager {
  #safeStorage;
  #shell;
  #settingsPath;
  #origin;
  #session = null;
  #loaded = false;
  #clock;

  constructor({ safeStorage, shell, settingsPath, controlPlaneUrl: url, clock = () => Date.now() }) {
    this.#safeStorage = safeStorage;
    this.#shell = shell;
    this.#settingsPath = settingsPath;
    this.#origin = controlPlaneUrl(url);
    this.#clock = clock;
  }

  async getState() {
    await this.#load();
    if (!this.#origin) return { availability: "not-configured", user: null, message: "Trace cloud is not configured for this build. Local work stays available." };
    if (!this.#session) return { availability: "ready", user: null, message: null };
    try {
      const user = await this.#request("/v1/auth/session", { method: "GET" }, true);
      this.#session.user = publicUser(user.user);
      await this.#persist();
      return { availability: "ready", user: this.#session.user, message: null };
    } catch (error) {
      // A previously verified session remains usable for local work while the
      // control plane is temporarily offline. Keep credentials private, but
      // let the renderer receive the cached public account state so launch
      // does not unnecessarily block the editor.
      if (error?.code === "CLOUD_UNAVAILABLE") {
        return {
          availability: "ready",
          user: this.#session.user,
          message: "Trace cloud could not be reached. Your local work is unaffected.",
        };
      }
      if (error?.code !== "UNAUTHENTICATED") throw error;
      const refreshed = await this.#refresh();
      if (!refreshed) return { availability: "ready", user: null, message: "Your Trace session expired. Sign in to continue." };
      return { availability: "ready", user: refreshed.user, message: null };
    }
  }

  async signUp(request) {
    const body = object(request, "sign-up request");
    await this.#request("/v1/auth/sign-up", {
      method: "POST",
      body: { email: text(body.email, "email", 254), displayName: text(body.displayName, "display name", 256), password: text(body.password, "password", 1024) },
    });
    return { accepted: true };
  }

  async signIn(request) {
    const body = object(request, "sign-in request");
    const response = await this.#request("/v1/auth/sign-in", {
      method: "POST",
      body: { email: text(body.email, "email", 254), password: text(body.password, "password", 1024), deviceId: this.#deviceId() },
    });
    await this.#storeSession(response);
    return { user: this.#session.user };
  }

  async resendVerification(request) {
    const body = object(request, "verification request");
    await this.#request("/v1/auth/resend-verification", { method: "POST", body: { email: text(body.email, "email", 254) } });
    return { accepted: true };
  }

  async requestPasswordReset(request) {
    const body = object(request, "password reset request");
    await this.#request("/v1/auth/request-password-reset", { method: "POST", body: { email: text(body.email, "email", 254) } });
    return { accepted: true };
  }

  async confirmPasswordReset(request) {
    const body = object(request, "password reset request");
    await this.#request("/v1/auth/confirm-password-reset", { method: "POST", body: { token: text(body.token, "reset token", 256), password: text(body.password, "password", 1024) } });
    return { accepted: true };
  }

  async refreshState() {
    const refreshed = await this.#refresh();
    return { user: refreshed?.user ?? null };
  }

  async signOut() {
    await this.#load();
    if (this.#session && this.#origin) {
      try { await this.#request("/v1/auth/sign-out", { method: "POST", body: { refreshToken: this.#session.refreshToken } }); } catch { /* Clearing local secure material still signs this device out. */ }
    }
    this.#session = null;
    await this.#persist();
    return { signedOut: true };
  }

  async beginGitHubLink() {
    const response = await this.#request("/v1/github/link/start", { method: "POST" }, true);
    const url = text(response.authorizationUrl, "GitHub authorization URL", MAX_URL_BYTES);
    await this.#shell.openExternal(url);
    return { opened: true };
  }

  async openGitHubAppInstall() {
    const response = await this.#request("/v1/github/app/install-url", { method: "GET" }, true);
    await this.#shell.openExternal(text(response.url, "GitHub App URL", MAX_URL_BYTES));
    return { opened: true };
  }

  async listInstallations() {
    const response = await this.#request("/v1/github/app/installations", { method: "GET" }, true);
    if (!Array.isArray(response.installations)) throw accountError("ACCOUNT_RESPONSE_INVALID", "Trace returned an invalid installation list.");
    return response.installations.map((installation) => ({
      id: text(installation?.id, "installation identity", 64),
      accountLogin: text(installation?.accountLogin, "installation account", 256),
      accountType: installation?.accountType === "User" || installation?.accountType === "Organization" ? installation.accountType : "User",
    }));
  }

  async listRepositories(installationId) {
    const response = await this.#request(`/v1/github/app/installations/${encodeURIComponent(text(installationId, "installation identity", 64))}/repositories`, { method: "GET" }, true);
    if (!Array.isArray(response.repositories)) throw accountError("ACCOUNT_RESPONSE_INVALID", "Trace returned an invalid repository list.");
    return response.repositories.map((repository) => ({
      id: text(repository?.id, "repository identity", 64), owner: text(repository?.owner, "repository owner", 128), name: text(repository?.name, "repository name", 128), defaultBranch: text(repository?.defaultBranch, "repository branch", 256), private: Boolean(repository?.private),
    }));
  }

  async createWorkspace(request) {
    const body = object(request, "workspace request");
    const repository = object(body.repository, "repository");
    const response = await this.#request("/v1/workspaces", {
      method: "POST",
      body: {
        name: text(body.name, "workspace name", 320),
        installationId: text(body.installationId, "installation identity", 64),
        repository: { provider: "github", owner: text(repository.owner, "repository owner", 128), name: text(repository.name, "repository name", 128), defaultBranch: text(repository.defaultBranch, "repository branch", 256) },
      },
    }, true);
    return { workspace: response.workspace, membership: response.membership };
  }

  async createInvite(request) {
    const body = object(request, "invite request");
    const workspaceId = text(body.workspaceId, "workspace identity", 128);
    const response = await this.#request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/invites`, {
      method: "POST", body: { email: text(body.email, "invite email", 254), ...(Number.isInteger(body.expiresInSeconds) ? { expiresInSeconds: body.expiresInSeconds } : {}) },
    }, true);
    return { invite: response.invite };
  }

  async redeemInvite(request) {
    const body = object(request, "invite request");
    const input = text(body.tokenOrLink, "invite code", MAX_URL_BYTES).trim();
    let token = input;
    try { token = new URL(input).searchParams.get("token") || input.split("/").at(-1) || input; } catch { /* Copyable raw token is supported. */ }
    const response = await this.#request("/v1/invites/redeem", { method: "POST", body: { token: text(token, "invite code", 128) } }, true);
    return { workspace: response.workspace, membership: response.membership };
  }

  async #refresh() {
    await this.#load();
    if (!this.#session || !this.#origin) return null;
    try {
      const response = await this.#request("/v1/auth/refresh", { method: "POST", body: { refreshToken: this.#session.refreshToken, deviceId: this.#deviceId() } });
      await this.#storeSession(response);
      return this.#session;
    } catch {
      this.#session = null;
      await this.#persist();
      return null;
    }
  }

  async #request(route, { method, body }, authenticated = false) {
    if (!this.#origin) throw accountError("CLOUD_NOT_CONFIGURED", "Trace cloud is not configured for this build.");
    await this.#load();
    const headers = { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...(authenticated && this.#session ? { authorization: `Bearer ${this.#session.accessToken}` } : {}) };
    let response;
    try {
      response = await fetch(`${this.#origin}${route}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) });
    } catch {
      throw accountError("CLOUD_UNAVAILABLE", "Trace cloud could not be reached. Your local work is unaffected.");
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const code = payload?.error?.code;
      const message = typeof payload?.error?.message === "string" ? payload.error.message : "Trace cloud could not complete that request.";
      throw accountError(typeof code === "string" ? code : "CLOUD_REQUEST_FAILED", message);
    }
    if (!payload || typeof payload !== "object") throw accountError("ACCOUNT_RESPONSE_INVALID", "Trace returned an invalid response.");
    return payload;
  }

  async #storeSession(response) {
    const accessToken = text(response?.accessToken, "access token", MAX_SETTINGS_BYTES);
    const refreshToken = text(response?.refreshToken, "refresh token", MAX_SETTINGS_BYTES);
    if (!this.#secureStorageAvailable()) {
      throw accountError("ACCOUNT_STORAGE_UNAVAILABLE", "Secure macOS storage is unavailable, so Trace cannot sign this device in.");
    }
    this.#session = { accessToken, refreshToken, user: publicUser(response?.user) };
    await this.#persist();
  }

  #deviceId() {
    return `mac-${crypto.createHash("sha256").update(`${process.platform}:${process.arch}:${this.#settingsPath}`).digest("base64url").slice(0, 42)}`;
  }

  #secureStorageAvailable() {
    return this.#safeStorage && typeof this.#safeStorage.encryptString === "function" && typeof this.#safeStorage.decryptString === "function" && (typeof this.#safeStorage.isEncryptionAvailable !== "function" || this.#safeStorage.isEncryptionAvailable());
  }

  async #load() {
    if (this.#loaded) return;
    this.#loaded = true;
    if (!this.#secureStorageAvailable()) return;
    let raw;
    try { raw = await fsp.readFile(this.#settingsPath, "utf8"); } catch (error) { if (error?.code === "ENOENT") return; throw accountError("ACCOUNT_STORAGE_INVALID", "Saved Trace account data could not be safely read."); }
    if (Buffer.byteLength(raw, "utf8") > MAX_SETTINGS_BYTES) throw accountError("ACCOUNT_STORAGE_INVALID", "Saved Trace account data could not be safely read.");
    try {
      const stored = JSON.parse(raw);
      if (stored?.version !== 1 || typeof stored.encryptedSession !== "string") throw new Error("invalid");
      const decrypted = this.#safeStorage.decryptString(Buffer.from(stored.encryptedSession, "base64"));
      const session = JSON.parse(decrypted);
      this.#session = { accessToken: text(session.accessToken, "access token", MAX_SETTINGS_BYTES), refreshToken: text(session.refreshToken, "refresh token", MAX_SETTINGS_BYTES), user: publicUser(session.user) };
    } catch {
      throw accountError("ACCOUNT_STORAGE_INVALID", "Saved Trace account data could not be safely read.");
    }
  }

  async #persist() {
    if (!this.#secureStorageAvailable()) {
      if (this.#session) throw accountError("ACCOUNT_STORAGE_UNAVAILABLE", "Secure macOS storage is unavailable, so Trace will not save your account session.");
      return;
    }
    if (!this.#session) {
      await fsp.rm(this.#settingsPath, { force: true });
      return;
    }
    const encrypted = this.#safeStorage.encryptString(JSON.stringify(this.#session));
    const encoded = JSON.stringify({ version: 1, encryptedSession: encrypted.toString("base64") });
    const directory = path.dirname(this.#settingsPath);
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.#settingsPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    await fsp.writeFile(temporary, encoded, { encoding: "utf8", mode: 0o600 });
    await fsp.rename(temporary, this.#settingsPath);
    await fsp.chmod(this.#settingsPath, 0o600);
  }
}

module.exports = { TraceAccountManager };
