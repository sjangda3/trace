import type { RawResult } from "../editor/bridge";

export const APPEARANCE_OPTIONS = ["system", "light", "dark"] as const;
export const ACCENT_OPTIONS = [
  "cobalt",
  "violet",
  "teal",
  "amber",
  "rose",
] as const;
export const CODE_SIZE_OPTIONS = ["small", "default", "large"] as const;

export type AppearancePreference = (typeof APPEARANCE_OPTIONS)[number];
export type AccentPreference = (typeof ACCENT_OPTIONS)[number];
export type CodeSizePreference = (typeof CODE_SIZE_OPTIONS)[number];
export type ResolvedAppearance = Exclude<AppearancePreference, "system">;
export type Appearance = AppearancePreference;
export type Accent = AccentPreference;
export type CodeSize = CodeSizePreference;

export interface PreferencesRecord {
  appearance: AppearancePreference;
  accent: AccentPreference;
  codeSize: CodeSizePreference;
}

export type AppPreferences = PreferencesRecord;
export type TracePreferences = PreferencesRecord;

export const DEFAULT_PREFERENCES: Readonly<PreferencesRecord> = Object.freeze({
  appearance: "system",
  accent: "cobalt",
  codeSize: "default",
});

function isOption<T extends string>(
  options: readonly T[],
  value: unknown,
): value is T {
  return typeof value === "string"
    && (options as readonly string[]).includes(value);
}

export function isAppearancePreference(
  value: unknown,
): value is AppearancePreference {
  return isOption(APPEARANCE_OPTIONS, value);
}

export function isAccentPreference(value: unknown): value is AccentPreference {
  return isOption(ACCENT_OPTIONS, value);
}

export function isCodeSizePreference(
  value: unknown,
): value is CodeSizePreference {
  return isOption(CODE_SIZE_OPTIONS, value);
}

/** Repairs persisted or bridge data field-by-field without sharing references. */
export function normalizePreferences(value: unknown): PreferencesRecord {
  const candidate = value && typeof value === "object"
    ? value as Partial<Record<keyof PreferencesRecord, unknown>>
    : {};

  return {
    appearance: isAppearancePreference(candidate.appearance)
      ? candidate.appearance
      : DEFAULT_PREFERENCES.appearance,
    accent: isAccentPreference(candidate.accent)
      ? candidate.accent
      : DEFAULT_PREFERENCES.accent,
    codeSize: isCodeSizePreference(candidate.codeSize)
      ? candidate.codeSize
      : DEFAULT_PREFERENCES.codeSize,
  };
}

/** The context-isolated API expected from Electron's preload script. */
export interface TracePreferencesBridge {
  get(): Promise<RawResult<PreferencesRecord>>;
  set(preferences: PreferencesRecord): Promise<RawResult<PreferencesRecord>>;
}

declare global {
  interface Window {
    tracePreferences?: TracePreferencesBridge;
  }
}
