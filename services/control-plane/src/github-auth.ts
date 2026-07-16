import { createHash, createSign, randomBytes } from "node:crypto";

export type GitHubOAuthIdentity = { providerSubject: string; login: string };
export type GitHubInstallation = { id: string; accountLogin: string; accountType: "User" | "Organization" };
export type GitHubRepository = { id: string; owner: string; name: string; defaultBranch: string; private: boolean };
export type GitHubInstallationAccess = GitHubInstallation & { repositories: GitHubRepository[] };

export interface GitHubOAuthClient {
  authorizationUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string;
  exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<{ identity: GitHubOAuthIdentity; installations: GitHubInstallationAccess[] }>;
}

export interface GitHubAppBroker {
  installationUrl(): string;
  listRepositories(installationId: string): Promise<GitHubRepository[]>;
}

function base64Url(value: Buffer | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

export function newPkceVerifier(): string {
  return base64Url(randomBytes(48));
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export class GitHubOAuthWebClient implements GitHubOAuthClient {
  constructor(private readonly options: { clientId: string; clientSecret: string; callbackUrl: string; fetch?: typeof fetch }) {}

  authorizationUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string {
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", this.options.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("state", input.state);
    url.searchParams.set("scope", "read:user");
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<{ identity: GitHubOAuthIdentity; installations: GitHubInstallationAccess[] }> {
    const request = this.options.fetch ?? globalThis.fetch;
    const tokens = await request("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.codeVerifier,
      }),
    });
    if (!tokens.ok) throw new Error("GitHub rejected the authorization code.");
    const tokenPayload = await tokens.json() as { access_token?: string };
    if (!tokenPayload.access_token) throw new Error("GitHub did not return an access token.");
    const headers = { authorization: `Bearer ${tokenPayload.access_token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
    const profile = await request("https://api.github.com/user", {
      headers,
    });
    if (!profile.ok) throw new Error("GitHub identity lookup failed.");
    const payload = await profile.json() as { id?: number; login?: string };
    if (!Number.isSafeInteger(payload.id) || typeof payload.login !== "string" || !payload.login) throw new Error("GitHub returned an invalid identity.");
    const installationsResponse = await request("https://api.github.com/user/installations?per_page=100", { headers });
    if (!installationsResponse.ok) throw new Error("GitHub installation access lookup failed.");
    const installationPayload = await installationsResponse.json() as { installations?: Array<{ id?: number; account?: { login?: string; type?: string } }> };
    const installations = await Promise.all((installationPayload.installations ?? []).slice(0, 100).flatMap((installation) => {
      if (!Number.isSafeInteger(installation.id) || !installation.account?.login || (installation.account.type !== "User" && installation.account.type !== "Organization")) return [];
      return [this.#userInstallationAccess(String(installation.id), installation.account.login, installation.account.type, headers)];
    }));
    return { identity: { providerSubject: String(payload.id), login: payload.login }, installations };
  }

  async #userInstallationAccess(installationId: string, accountLogin: string, accountType: "User" | "Organization", headers: Record<string, string>): Promise<GitHubInstallationAccess> {
    const request = this.options.fetch ?? globalThis.fetch;
    const response = await request(`https://api.github.com/user/installations/${encodeURIComponent(installationId)}/repositories?per_page=100`, { headers });
    if (!response.ok) throw new Error("GitHub repository access lookup failed.");
    const payload = await response.json() as { repositories?: Array<{ id?: number; name?: string; private?: boolean; owner?: { login?: string }; default_branch?: string }> };
    const repositories = (payload.repositories ?? []).flatMap((repository) => {
      if (!Number.isSafeInteger(repository.id) || !repository.name || !repository.owner?.login || !repository.default_branch || typeof repository.private !== "boolean") return [];
      return [{ id: String(repository.id), owner: repository.owner.login, name: repository.name, defaultBranch: repository.default_branch, private: repository.private }];
    });
    return { id: installationId, accountLogin, accountType, repositories };
  }
}

export class GitHubAppApiBroker implements GitHubAppBroker {
  constructor(private readonly options: { appId: string; privateKey: string; slug: string; fetch?: typeof fetch; clock?: () => Date }) {}

  installationUrl(): string {
    return `https://github.com/apps/${encodeURIComponent(this.options.slug)}/installations/new`;
  }

  async listRepositories(installationId: string): Promise<GitHubRepository[]> {
    if (!/^\d+$/u.test(installationId)) throw new Error("The GitHub App installation is invalid.");
    const installationToken = await this.#installationToken(installationId);
    const request = this.options.fetch ?? globalThis.fetch;
    const response = await request(`https://api.github.com/installation/repositories?per_page=100`, {
      headers: { authorization: `Bearer ${installationToken}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    });
    if (!response.ok) throw new Error("GitHub App repositories could not be loaded.");
    const payload = await response.json() as { repositories?: Array<{ id?: number; name?: string; private?: boolean; owner?: { login?: string }; default_branch?: string }> };
    return (payload.repositories ?? []).flatMap((repository) => {
      if (!Number.isSafeInteger(repository.id) || !repository.name || !repository.owner?.login || !repository.default_branch || typeof repository.private !== "boolean") return [];
      return [{ id: String(repository.id), owner: repository.owner.login, name: repository.name, defaultBranch: repository.default_branch, private: repository.private }];
    });
  }

  async #installationToken(installationId: string): Promise<string> {
    const response = await this.#request(`/app/installations/${installationId}/access_tokens`, { method: "POST" });
    if (!response.ok) throw new Error("GitHub App installation could not be authorized.");
    const payload = await response.json() as { token?: string };
    if (!payload.token) throw new Error("GitHub App did not return an installation token.");
    return payload.token;
  }

  #appJwt(): string {
    const now = Math.floor((this.options.clock ?? (() => new Date()))().getTime() / 1000);
    const header = base64Url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
    const payload = base64Url(Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.options.appId })));
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${payload}`);
    signer.end();
    return `${header}.${payload}.${signer.sign(this.options.privateKey).toString("base64url")}`;
  }

  #request(path: string, init: RequestInit = {}): Promise<Response> {
    const request = this.options.fetch ?? globalThis.fetch;
    return request(`https://api.github.com${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.#appJwt()}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(init.headers ?? {}) },
    });
  }
}
