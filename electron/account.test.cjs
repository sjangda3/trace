const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { TraceAccountManager } = require("./account.cjs");

function secureStorage() {
  const key = Buffer.alloc(32, 31);
  const xor = (value) => Buffer.from([...Buffer.from(value)].map((byte, index) => byte ^ key[index % key.length]));
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => xor(value),
    decryptString: (value) => xor(value).toString("utf8"),
  };
}

function user() {
  return { id: "account-1", email: "sameer@example.com", displayName: "Sameer", emailVerified: true, githubLinked: false };
}

test("Electron account bridge persists only encrypted session material and never exposes tokens", async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "trace-account-test-"));
  const settingsPath = path.join(directory, "session.json");
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), authorization: init.headers?.authorization ?? null });
    const route = new URL(String(url)).pathname;
    if (route === "/v1/auth/sign-in") return new Response(JSON.stringify({ accessToken: "access-secret", refreshToken: "refresh-secret", user: user() }), { status: 200, headers: { "content-type": "application/json" } });
    if (route === "/v1/auth/session") return new Response(JSON.stringify({ user: user() }), { status: 200, headers: { "content-type": "application/json" } });
    if (route === "/v1/auth/sign-out") return new Response(JSON.stringify({ accepted: true }), { status: 200, headers: { "content-type": "application/json" } });
    throw new Error(`Unexpected route ${route}`);
  };
  t.after(async () => { global.fetch = originalFetch; await fsp.rm(directory, { recursive: true, force: true }); });

  const manager = new TraceAccountManager({ safeStorage: secureStorage(), shell: { openExternal: async () => undefined }, settingsPath, controlPlaneUrl: "https://trace.test" });
  const result = await manager.signIn({ email: "sameer@example.com", password: "password-for-testing" });
  assert.deepEqual(result, { user: user() });
  assert.equal(Object.hasOwn(result, "accessToken"), false);
  const stored = await fsp.readFile(settingsPath, "utf8");
  assert.equal(stored.includes("access-secret"), false);
  assert.equal(stored.includes("refresh-secret"), false);

  const restored = new TraceAccountManager({ safeStorage: secureStorage(), shell: { openExternal: async () => undefined }, settingsPath, controlPlaneUrl: "https://trace.test" });
  const state = await restored.getState();
  assert.deepEqual(state.user, user());
  assert.equal(calls.some((call) => call.authorization === "Bearer access-secret"), true);
  await restored.signOut();
  await assert.rejects(fsp.stat(settingsPath), { code: "ENOENT" });
});

test("Electron account bridge preserves local mode when cloud is not configured", async () => {
  const manager = new TraceAccountManager({ safeStorage: secureStorage(), shell: { openExternal: async () => undefined }, settingsPath: path.join(os.tmpdir(), `trace-${crypto.randomUUID()}.json`), controlPlaneUrl: "" });
  const state = await manager.getState();
  assert.equal(state.availability, "not-configured");
  assert.equal(state.user, null);
});

test("Electron account bridge sends only the expected POST sign-up payload", async (t) => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ accepted: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => { global.fetch = originalFetch; });

  const manager = new TraceAccountManager({
    safeStorage: secureStorage(),
    shell: { openExternal: async () => undefined },
    settingsPath: path.join(os.tmpdir(), `trace-sign-up-${crypto.randomUUID()}.json`),
    controlPlaneUrl: "https://trace.test",
  });
  const result = await manager.signUp({
    displayName: "Sameer",
    email: "sameer@example.com",
    password: "password-for-testing",
  });

  assert.deepEqual(result, { accepted: true });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(new URL(call.url).pathname, "/v1/auth/sign-up");
  assert.equal(call.init.method, "POST");
  assert.deepEqual(JSON.parse(call.init.body), {
    email: "sameer@example.com",
    displayName: "Sameer",
    password: "password-for-testing",
  });
});

test("Electron account bridge keeps a cached verified session available while cloud is offline", async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "trace-account-offline-test-"));
  const settingsPath = path.join(directory, "session.json");
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error("offline"); };
  t.after(async () => { global.fetch = originalFetch; await fsp.rm(directory, { recursive: true, force: true }); });

  const encrypted = secureStorage().encryptString(JSON.stringify({ accessToken: "access-secret", refreshToken: "refresh-secret", user: user() }));
  await fsp.writeFile(settingsPath, JSON.stringify({ version: 1, encryptedSession: encrypted.toString("base64") }), { mode: 0o600 });
  const manager = new TraceAccountManager({ safeStorage: secureStorage(), shell: { openExternal: async () => undefined }, settingsPath, controlPlaneUrl: "https://trace.test" });

  const state = await manager.getState();
  assert.deepEqual(state.user, user());
  assert.match(state.message, /could not be reached/i);
});
