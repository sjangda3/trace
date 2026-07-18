import {
  DEFAULT_PREFERENCES,
  normalizePreferences,
  type PreferencesRecord,
  type TracePreferencesBridge,
} from "./types";
import type { RawResult } from "../editor/bridge";

export interface PreferencesApi {
  get(): Promise<PreferencesRecord>;
  set(preferences: PreferencesRecord): Promise<PreferencesRecord>;
}

export class PreferencesApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PreferencesApiError";
  }
}

function unwrap<T>(result: RawResult<T>): T {
  if (result.ok) return result.value;
  throw new PreferencesApiError(result.error.code, result.error.message);
}

export class ElectronPreferencesApi implements PreferencesApi {
  constructor(private readonly bridge: TracePreferencesBridge) {}

  async get(): Promise<PreferencesRecord> {
    return normalizePreferences(unwrap(await this.bridge.get()));
  }

  async set(preferences: PreferencesRecord): Promise<PreferencesRecord> {
    const next = normalizePreferences(preferences);
    return normalizePreferences(unwrap(await this.bridge.set(next)));
  }
}

/** Browser/test fallback used when Electron's preload bridge is unavailable. */
export class MemoryPreferencesApi implements PreferencesApi {
  private preferences: PreferencesRecord;

  constructor(initialPreferences: unknown = DEFAULT_PREFERENCES) {
    this.preferences = normalizePreferences(initialPreferences);
  }

  async get(): Promise<PreferencesRecord> {
    return normalizePreferences(this.preferences);
  }

  async set(preferences: PreferencesRecord): Promise<PreferencesRecord> {
    this.preferences = normalizePreferences(preferences);
    return normalizePreferences(this.preferences);
  }
}

export function createPreferencesApi(
  bridge: TracePreferencesBridge | undefined = typeof window !== "undefined"
    ? window.tracePreferences
    : undefined,
): PreferencesApi {
  return bridge
    ? new ElectronPreferencesApi(bridge)
    : new MemoryPreferencesApi();
}

export const tracePreferencesApi = createPreferencesApi();
