const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  DEFAULT_TRACE_PREFERENCES,
  MAX_PREFERENCES_BYTES,
  PREFERENCES_VERSION,
  TracePreferences,
} = require("./preferences.cjs");

async function preferencesFixture(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "trace-preferences-test-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return {
    directory,
    settingsPath: path.join(directory, "preferences.json"),
  };
}

test("TracePreferences returns defaults when storage is missing without creating a file", async (t) => {
  const { settingsPath } = await preferencesFixture(t);
  const preferences = new TracePreferences({ settingsPath });

  assert.deepEqual(await preferences.get(), DEFAULT_TRACE_PREFERENCES);
  await assert.rejects(fsp.stat(settingsPath), { code: "ENOENT" });
});

test("TracePreferences persists an exact versioned record atomically with private file permissions", async (t) => {
  const { directory, settingsPath } = await preferencesFixture(t);
  const preferences = new TracePreferences({ settingsPath });
  const next = { appearance: "dark", accent: "violet", codeSize: "large" };

  assert.deepEqual(await preferences.set(next), next);
  const stored = JSON.parse(await fsp.readFile(settingsPath, "utf8"));
  assert.deepEqual(stored, { version: PREFERENCES_VERSION, ...next });
  assert.equal((await fsp.stat(settingsPath)).mode & 0o777, 0o600);
  assert.deepEqual(
    (await fsp.readdir(directory)).filter((entry) => entry.includes(".tmp-")),
    [],
  );

  const restored = new TracePreferences({ settingsPath });
  assert.deepEqual(await restored.get(), next);
});

test("TracePreferences requires a complete known preference record and protects stored state on rejection", async (t) => {
  const { settingsPath } = await preferencesFixture(t);
  const preferences = new TracePreferences({ settingsPath });
  const initial = { appearance: "light", accent: "teal", codeSize: "small" };
  await preferences.set(initial);
  const serializedInitial = await fsp.readFile(settingsPath, "utf8");

  for (const invalid of [
    { appearance: "dark", accent: "violet" },
    { appearance: "dark", accent: "violet", codeSize: "large", extra: true },
    { appearance: "automatic", accent: "violet", codeSize: "large" },
    { appearance: "dark", accent: "blue", codeSize: "large" },
    { appearance: "dark", accent: "violet", codeSize: "medium" },
    null,
  ]) {
    await assert.rejects(preferences.set(invalid), TypeError);
  }

  assert.deepEqual(await preferences.get(), initial);
  assert.equal(await fsp.readFile(settingsPath, "utf8"), serializedInitial);
});

test("TracePreferences falls back safely for malformed, unsupported, oversized, and structurally invalid storage", async (t) => {
  const { settingsPath } = await preferencesFixture(t);
  const cases = [
    "not json",
    JSON.stringify({ version: PREFERENCES_VERSION + 1, ...DEFAULT_TRACE_PREFERENCES }),
    JSON.stringify({ version: PREFERENCES_VERSION, ...DEFAULT_TRACE_PREFERENCES, unknown: true }),
    JSON.stringify({ version: PREFERENCES_VERSION, appearance: "dark", accent: "violet" }),
    "x".repeat(MAX_PREFERENCES_BYTES + 1),
  ];

  for (const contents of cases) {
    await fsp.writeFile(settingsPath, contents, { mode: 0o600 });
    const preferences = new TracePreferences({ settingsPath });
    assert.deepEqual(await preferences.get(), DEFAULT_TRACE_PREFERENCES);
  }
});

test("TracePreferences returns detached records", async (t) => {
  const { settingsPath } = await preferencesFixture(t);
  const preferences = new TracePreferences({ settingsPath });

  const first = await preferences.get();
  first.accent = "rose";
  assert.deepEqual(await preferences.get(), DEFAULT_TRACE_PREFERENCES);

  const saved = await preferences.set({ appearance: "system", accent: "amber", codeSize: "default" });
  saved.codeSize = "small";
  assert.deepEqual(await preferences.get(), { appearance: "system", accent: "amber", codeSize: "default" });
});

test("TracePreferences serializes concurrent writes in call order", async (t) => {
  const { settingsPath } = await preferencesFixture(t);
  const preferences = new TracePreferences({ settingsPath });

  const first = preferences.set({ appearance: "light", accent: "teal", codeSize: "small" });
  const second = preferences.set({ appearance: "dark", accent: "rose", codeSize: "large" });
  await Promise.all([first, second]);

  assert.deepEqual(await preferences.get(), { appearance: "dark", accent: "rose", codeSize: "large" });
});

test("TracePreferences rejects invalid construction options and unsafe temporary names", async (t) => {
  const { settingsPath } = await preferencesFixture(t);
  assert.throws(() => new TracePreferences(), TypeError);
  assert.throws(() => new TracePreferences({ settingsPath: "" }), TypeError);
  assert.throws(() => new TracePreferences({ settingsPath: "preferences.json", randomUUID: null }), TypeError);
  await assert.rejects(
    new TracePreferences({ settingsPath, randomUUID: () => "invalid/path" }).set(DEFAULT_TRACE_PREFERENCES),
    /safe temporary filename/i,
  );
});
