// @vitest-environment jsdom

import { act } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PREFERENCES,
  PreferencesProvider,
  applyPreferencesToRoot,
  createPreferencesApi,
  normalizePreferences,
  resolveAppearance,
  usePreferences,
  type PreferencesApi,
  type PreferencesContextValue,
  type PreferencesRecord,
  type TracePreferencesBridge,
} from ".";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function installMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mediaQuery = {
    get matches() {
      return matches;
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      if (type === "change") {
        listeners.add(listener as (event: MediaQueryListEvent) => void);
      }
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener) => {
      if (type === "change") {
        listeners.delete(listener as (event: MediaQueryListEvent) => void);
      }
    }),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  } as unknown as MediaQueryList;

  vi.stubGlobal("matchMedia", vi.fn(() => mediaQuery));
  return {
    mediaQuery,
    setMatches(nextMatches: boolean) {
      matches = nextMatches;
      const event = { matches } as MediaQueryListEvent;
      listeners.forEach((listener) => listener(event));
    },
  };
}

let latestContext: PreferencesContextValue | null = null;

function ContextProbe() {
  latestContext = usePreferences();
  return (
    <output data-testid="preferences">
      {JSON.stringify(latestContext.preferences)}
    </output>
  );
}

beforeEach(() => {
  latestContext = null;
  installMatchMedia(false);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-accent");
  document.documentElement.removeAttribute("data-code-size");
  delete window.tracePreferences;
});

describe("preference types and bridge", () => {
  it("uses stable defaults and repairs invalid persisted fields independently", () => {
    expect(DEFAULT_PREFERENCES).toEqual({
      appearance: "system",
      accent: "cobalt",
      codeSize: "default",
    });
    expect(normalizePreferences({
      appearance: "dark",
      accent: "not-an-accent",
      codeSize: "large",
    })).toEqual({
      appearance: "dark",
      accent: "cobalt",
      codeSize: "large",
    });
    expect(normalizePreferences(null)).toEqual(DEFAULT_PREFERENCES);
  });

  it("wraps window.tracePreferences and always sends a full normalized record", async () => {
    const stored: PreferencesRecord = {
      appearance: "dark",
      accent: "violet",
      codeSize: "small",
    };
    const bridge: TracePreferencesBridge = {
      get: vi.fn(async () => ({ ok: true as const, value: stored })),
      set: vi.fn(async (preferences: PreferencesRecord) => ({
        ok: true as const,
        value: preferences,
      })),
    };
    window.tracePreferences = bridge;
    const api = createPreferencesApi();

    expect(await api.get()).toEqual({
      appearance: "dark",
      accent: "violet",
      codeSize: "small",
    });
    const next: PreferencesRecord = {
      appearance: "light",
      accent: "amber",
      codeSize: "large",
    };
    expect(await api.set(next)).toEqual(next);
    expect(bridge.set).toHaveBeenCalledWith(next);
  });

  it("resolves system appearance and applies all root attributes together", () => {
    const root = document.createElement("div");
    expect(resolveAppearance("system", true)).toBe("dark");
    expect(resolveAppearance("system", false)).toBe("light");
    expect(resolveAppearance("dark", false)).toBe("dark");
    expect(applyPreferencesToRoot(root, {
      appearance: "system",
      accent: "rose",
      codeSize: "small",
    }, true)).toBe("dark");
    expect(root.dataset).toMatchObject({
      theme: "dark",
      accent: "rose",
      codeSize: "small",
    });
  });
});

describe("PreferencesProvider", () => {
  it("loads preferences, follows the macOS color scheme, and restores root state", async () => {
    const system = installMatchMedia(true);
    const stored: PreferencesRecord = {
      appearance: "system",
      accent: "teal",
      codeSize: "large",
    };
    const api: PreferencesApi = {
      get: vi.fn(async () => stored),
      set: vi.fn(async (preferences) => preferences),
    };
    const root = document.documentElement;
    root.setAttribute("data-theme", "existing");
    root.setAttribute("data-accent", "existing");
    root.setAttribute("data-code-size", "existing");

    const result = render(
      <PreferencesProvider api={api}>
        <ContextProbe />
      </PreferencesProvider>,
    );

    await waitFor(() => expect(latestContext?.isLoading).toBe(false));
    expect(latestContext?.resolvedAppearance).toBe("dark");
    expect(root.dataset).toMatchObject({
      theme: "dark",
      accent: "teal",
      codeSize: "large",
    });

    act(() => system.setMatches(false));
    expect(latestContext?.resolvedAppearance).toBe("light");
    expect(root.dataset.theme).toBe("light");

    result.unmount();
    expect(root.dataset).toMatchObject({
      theme: "existing",
      accent: "existing",
      codeSize: "existing",
    });
    expect(system.mediaQuery.removeEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    );
  });

  it("applies a full record optimistically and rolls back a failed save", async () => {
    const initial: PreferencesRecord = {
      appearance: "light",
      accent: "cobalt",
      codeSize: "default",
    };
    const pendingSave = deferred<PreferencesRecord>();
    const api: PreferencesApi = {
      get: vi.fn(async () => initial),
      set: vi.fn(() => pendingSave.promise),
    };
    render(
      <PreferencesProvider api={api}>
        <ContextProbe />
      </PreferencesProvider>,
    );
    await waitFor(() => expect(latestContext?.isLoading).toBe(false));

    const next: PreferencesRecord = {
      appearance: "dark",
      accent: "rose",
      codeSize: "large",
    };
    let savePromise!: Promise<PreferencesRecord>;
    await act(async () => {
      savePromise = latestContext!.savePreferences(next);
      await Promise.resolve();
    });

    expect(latestContext?.preferences).toEqual(next);
    expect(latestContext?.isSaving).toBe(true);
    expect(document.documentElement.dataset).toMatchObject({
      theme: "dark",
      accent: "rose",
      codeSize: "large",
    });
    expect(api.set).toHaveBeenCalledWith(next);

    await act(async () => {
      pendingSave.reject(new Error("disk unavailable"));
      await savePromise.catch(() => undefined);
    });

    expect(latestContext?.preferences).toEqual(initial);
    expect(latestContext?.isSaving).toBe(false);
    expect(latestContext?.error?.message).toBe("disk unavailable");
    expect(document.documentElement.dataset).toMatchObject({
      theme: "light",
      accent: "cobalt",
      codeSize: "default",
    });
  });

  it("uses a late initial read as the durable rollback baseline for an early failed save", async () => {
    const durable: PreferencesRecord = {
      appearance: "dark",
      accent: "teal",
      codeSize: "large",
    };
    const optimistic: PreferencesRecord = {
      appearance: "light",
      accent: "rose",
      codeSize: "small",
    };
    const initialRead = deferred<PreferencesRecord>();
    const pendingSave = deferred<PreferencesRecord>();
    const api: PreferencesApi = {
      get: vi.fn(() => initialRead.promise),
      set: vi.fn(() => pendingSave.promise),
    };
    render(
      <PreferencesProvider api={api}>
        <ContextProbe />
      </PreferencesProvider>,
    );

    let savePromise!: Promise<PreferencesRecord>;
    await act(async () => {
      savePromise = latestContext!.savePreferences(optimistic);
      await Promise.resolve();
    });
    await waitFor(() => expect(api.set).toHaveBeenCalledWith(optimistic));
    expect(latestContext?.preferences).toEqual(optimistic);

    await act(async () => {
      initialRead.resolve(durable);
      await initialRead.promise;
    });
    // A late read establishes the durable baseline without replacing the
    // optimistic UI while that user's save is still pending.
    expect(latestContext?.preferences).toEqual(optimistic);

    await act(async () => {
      pendingSave.reject(new Error("disk unavailable"));
      await savePromise.catch(() => undefined);
    });

    expect(latestContext?.preferences).toEqual(durable);
    expect(document.documentElement.dataset).toMatchObject({
      theme: "dark",
      accent: "teal",
      codeSize: "large",
    });
  });
});
