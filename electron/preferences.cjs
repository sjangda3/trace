"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const PREFERENCES_VERSION = 1;
const MAX_PREFERENCES_BYTES = 8 * 1024;

const APPEARANCES = Object.freeze(["system", "light", "dark"]);
const ACCENTS = Object.freeze(["cobalt", "violet", "teal", "amber", "rose"]);
const CODE_SIZES = Object.freeze(["small", "default", "large"]);

const DEFAULT_TRACE_PREFERENCES = Object.freeze({
  appearance: "system",
  accent: "cobalt",
  codeSize: "default",
});

function clonePreferences(preferences) {
  return {
    appearance: preferences.appearance,
    accent: preferences.accent,
    codeSize: preferences.codeSize,
  };
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, keys) {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function invalidPreferences() {
  throw new TypeError("Trace preferences must be a complete valid preference record.");
}

/**
 * Validates the public in-memory preference shape. This intentionally accepts
 * only a complete record, so callers cannot silently leave an unsupported
 * value behind when new preferences are added in a later storage version.
 */
function validateTracePreferences(value) {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["appearance", "accent", "codeSize"])) {
    invalidPreferences();
  }

  if (!APPEARANCES.includes(value.appearance) ||
      !ACCENTS.includes(value.accent) ||
      !CODE_SIZES.includes(value.codeSize)) {
    invalidPreferences();
  }

  return clonePreferences(value);
}

function parseStoredPreferences(value) {
  if (!isPlainRecord(value) ||
      !hasExactKeys(value, ["version", "appearance", "accent", "codeSize"]) ||
      value.version !== PREFERENCES_VERSION) {
    return null;
  }

  try {
    return validateTracePreferences({
      appearance: value.appearance,
      accent: value.accent,
      codeSize: value.codeSize,
    });
  } catch {
    return null;
  }
}

function temporarySuffix(randomUUID) {
  const suffix = randomUUID();
  if (typeof suffix !== "string" || !/^[A-Za-z0-9-]{1,128}$/u.test(suffix)) {
    throw new Error("Trace preferences could not create a safe temporary filename.");
  }
  return suffix;
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fsp.open(directory, "r");
    await handle.sync();
  } catch (error) {
    // Directory fsync is not available on every platform or filesystem. The
    // renamed file is still atomic; only ignore the known unsupported cases.
    if (!["EINVAL", "ENOTSUP", "EISDIR"].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

class TracePreferences {
  #settingsPath;
  #randomUUID;
  #preferences = clonePreferences(DEFAULT_TRACE_PREFERENCES);
  #loadPromise = null;
  #storeTail = Promise.resolve();

  constructor({ settingsPath, randomUUID = crypto.randomUUID } = {}) {
    if (typeof settingsPath !== "string" || settingsPath.trim().length === 0) {
      throw new TypeError("Trace preferences require a settings path.");
    }
    if (typeof randomUUID !== "function") {
      throw new TypeError("Trace preferences require a random UUID generator.");
    }
    this.#settingsPath = settingsPath;
    this.#randomUUID = randomUUID;
  }

  /** Returns an isolated copy of the current full preference record. */
  async get() {
    await this.#storeTail;
    await this.#ensureLoaded();
    return clonePreferences(this.#preferences);
  }

  /**
   * Replaces the complete preference record after strict validation. A failed
   * write leaves the in-memory record unchanged.
   */
  async set(preferences) {
    const next = validateTracePreferences(preferences);
    const operation = this.#storeTail.then(async () => {
      await this.#ensureLoaded();
      await this.#persist(next);
      this.#preferences = next;
      return clonePreferences(next);
    }, async () => {
      await this.#ensureLoaded();
      await this.#persist(next);
      this.#preferences = next;
      return clonePreferences(next);
    });
    this.#storeTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #ensureLoaded() {
    if (!this.#loadPromise) {
      this.#loadPromise = this.#load();
    }
    await this.#loadPromise;
  }

  async #load() {
    const stored = await this.#readStoredPreferences();
    this.#preferences = stored ?? clonePreferences(DEFAULT_TRACE_PREFERENCES);
  }

  async #readStoredPreferences() {
    let handle;
    try {
      const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
      handle = await fsp.open(this.#settingsPath, flags);
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > MAX_PREFERENCES_BYTES) return null;

      const contents = await handle.readFile();
      if (contents.length > MAX_PREFERENCES_BYTES) return null;

      let decoded;
      try {
        decoded = JSON.parse(contents.toString("utf8"));
      } catch {
        return null;
      }
      return parseStoredPreferences(decoded);
    } catch {
      // Preferences are nonessential. Missing, damaged, unreadable, or
      // symlinked storage must never prevent Trace from starting.
      return null;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async #persist(preferences) {
    const contents = Buffer.from(JSON.stringify({
      version: PREFERENCES_VERSION,
      ...preferences,
    }), "utf8");
    if (contents.length > MAX_PREFERENCES_BYTES) {
      throw new RangeError("Trace preferences are too large to save.");
    }

    const directory = path.dirname(this.#settingsPath);
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    await fsp.chmod(directory, 0o700).catch(() => {});

    const temporaryPath = `${this.#settingsPath}.tmp-${process.pid}-${temporarySuffix(this.#randomUUID)}`;
    let handle;
    try {
      handle = await fsp.open(temporaryPath, "wx", 0o600);
      await handle.writeFile(contents);
      await handle.sync();
      await handle.close();
      handle = null;

      await fsp.rename(temporaryPath, this.#settingsPath);
      await fsp.chmod(this.#settingsPath, 0o600);
      await syncDirectory(directory);
    } catch (error) {
      await handle?.close().catch(() => {});
      await fsp.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }
}

module.exports = {
  ACCENTS,
  APPEARANCES,
  CODE_SIZES,
  DEFAULT_TRACE_PREFERENCES,
  MAX_PREFERENCES_BYTES,
  PREFERENCES_VERSION,
  TracePreferences,
  validateTracePreferences,
};
