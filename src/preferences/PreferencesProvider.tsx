import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { tracePreferencesApi, type PreferencesApi } from "./api";
import {
  DEFAULT_PREFERENCES,
  normalizePreferences,
  type AppearancePreference,
  type PreferencesRecord,
  type ResolvedAppearance,
} from "./types";

export const SYSTEM_DARK_MODE_QUERY = "(prefers-color-scheme: dark)";

export function resolveAppearance(
  appearance: AppearancePreference,
  systemPrefersDark: boolean,
): ResolvedAppearance {
  return appearance === "system"
    ? systemPrefersDark ? "dark" : "light"
    : appearance;
}

export function applyPreferencesToRoot(
  root: HTMLElement,
  preferences: PreferencesRecord,
  systemPrefersDark: boolean,
): ResolvedAppearance {
  const resolvedAppearance = resolveAppearance(
    preferences.appearance,
    systemPrefersDark,
  );
  root.setAttribute("data-theme", resolvedAppearance);
  root.setAttribute("data-accent", preferences.accent);
  root.setAttribute("data-code-size", preferences.codeSize);
  return resolvedAppearance;
}

interface RootAttributeSnapshot {
  theme: string | null;
  accent: string | null;
  codeSize: string | null;
}

function restoreAttribute(
  root: HTMLElement,
  name: string,
  value: string | null,
) {
  if (value === null) root.removeAttribute(name);
  else root.setAttribute(name, value);
}

function readSystemPrefersDark() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(SYSTEM_DARK_MODE_QUERY).matches;
}

function asError(reason: unknown, fallbackMessage: string) {
  return reason instanceof Error
    ? reason
    : new Error(fallbackMessage);
}

export interface PreferencesContextValue {
  preferences: PreferencesRecord;
  resolvedAppearance: ResolvedAppearance;
  resolvedTheme: ResolvedAppearance;
  isLoading: boolean;
  isSaving: boolean;
  error: Error | null;
  savePreferences(preferences: PreferencesRecord): Promise<PreferencesRecord>;
}

export interface PreferencesProviderProps {
  children: ReactNode;
  api?: PreferencesApi;
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);
const useDomLayoutEffect = typeof window === "undefined"
  ? useEffect
  : useLayoutEffect;

export function PreferencesProvider({
  children,
  api = tracePreferencesApi,
}: PreferencesProviderProps) {
  const [preferences, setPreferences] = useState<PreferencesRecord>(() => (
    normalizePreferences(DEFAULT_PREFERENCES)
  ));
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    readSystemPrefersDark,
  );
  const [isLoading, setIsLoading] = useState(true);
  const [pendingSaveCount, setPendingSaveCount] = useState(0);
  const [error, setError] = useState<Error | null>(null);
  const mountedRef = useRef(false);
  const committedPreferencesRef = useRef<PreferencesRecord>(
    normalizePreferences(DEFAULT_PREFERENCES),
  );
  // An optimistic save may start before the asynchronous initial read finishes.
  // Keep the loaded record as the rollback baseline until a save has actually
  // succeeded; a request merely being in flight must not discard the last
  // durable value.
  const hasCommittedSaveRef = useRef(false);
  const pendingSavesRef = useRef(0);
  const latestSaveIdRef = useRef(0);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const rootSnapshotRef = useRef<RootAttributeSnapshot | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    void api.get().then(
      (loadedPreferences) => {
        if (cancelled || !mountedRef.current) return;
        const loaded = normalizePreferences(loadedPreferences);
        if (!hasCommittedSaveRef.current) {
          committedPreferencesRef.current = loaded;
          // Do not replace an optimistic selection while its persistence is
          // pending. If it fails, the catch path will restore this baseline.
          if (pendingSavesRef.current === 0) setPreferences(loaded);
        }
        setIsLoading(false);
      },
      (reason: unknown) => {
        if (cancelled || !mountedRef.current) return;
        setError(asError(reason, "Unable to load preferences."));
        setIsLoading(false);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }

    const mediaQuery = window.matchMedia(SYSTEM_DARK_MODE_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      setSystemPrefersDark(event.matches);
    };
    setSystemPrefersDark(mediaQuery.matches);
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  useDomLayoutEffect(() => {
    if (typeof document === "undefined") return undefined;
    const root = document.documentElement;
    rootSnapshotRef.current = {
      theme: root.getAttribute("data-theme"),
      accent: root.getAttribute("data-accent"),
      codeSize: root.getAttribute("data-code-size"),
    };

    return () => {
      const snapshot = rootSnapshotRef.current;
      if (!snapshot) return;
      restoreAttribute(root, "data-theme", snapshot.theme);
      restoreAttribute(root, "data-accent", snapshot.accent);
      restoreAttribute(root, "data-code-size", snapshot.codeSize);
      rootSnapshotRef.current = null;
    };
  }, []);

  useDomLayoutEffect(() => {
    if (typeof document === "undefined") return;
    applyPreferencesToRoot(
      document.documentElement,
      preferences,
      systemPrefersDark,
    );
  }, [preferences, systemPrefersDark]);

  const savePreferences = useCallback((nextPreferences: PreferencesRecord) => {
    const next = normalizePreferences(nextPreferences);
    const saveId = latestSaveIdRef.current + 1;
    latestSaveIdRef.current = saveId;
    pendingSavesRef.current += 1;
    setPreferences(next);
    setError(null);
    setPendingSaveCount((count) => count + 1);

    const save = saveQueueRef.current.then(async () => {
      try {
        const saved = normalizePreferences(await api.set(next));
        committedPreferencesRef.current = saved;
        hasCommittedSaveRef.current = true;
        if (mountedRef.current && saveId === latestSaveIdRef.current) {
          setPreferences(saved);
        }
        return saved;
      } catch (reason) {
        const failure = asError(reason, "Unable to save preferences.");
        if (mountedRef.current && saveId === latestSaveIdRef.current) {
          setPreferences(committedPreferencesRef.current);
          setError(failure);
        }
        throw failure;
      } finally {
        pendingSavesRef.current = Math.max(0, pendingSavesRef.current - 1);
        if (mountedRef.current) {
          setPendingSaveCount((count) => Math.max(0, count - 1));
        }
      }
    });

    saveQueueRef.current = save.then(
      () => undefined,
      () => undefined,
    );
    return save;
  }, [api]);

  const resolvedAppearance = resolveAppearance(
    preferences.appearance,
    systemPrefersDark,
  );
  const value = useMemo<PreferencesContextValue>(() => ({
    preferences,
    resolvedAppearance,
    resolvedTheme: resolvedAppearance,
    isLoading,
    isSaving: pendingSaveCount > 0,
    error,
    savePreferences,
  }), [
    error,
    isLoading,
    pendingSaveCount,
    preferences,
    resolvedAppearance,
    savePreferences,
  ]);

  return (
    <PreferencesContext.Provider value={value}>
      {children}
    </PreferencesContext.Provider>
  );
}

export function usePreferences(): PreferencesContextValue {
  const value = useContext(PreferencesContext);
  if (!value) {
    throw new Error("usePreferences must be used within PreferencesProvider.");
  }
  return value;
}
