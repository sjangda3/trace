import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const monacoHarness = vi.hoisted(() => ({
  defineTheme: vi.fn(),
  javascriptDefaults: {
    setDiagnosticsOptions: vi.fn(),
    setEagerModelSync: vi.fn(),
  },
  typescriptDefaults: {
    setDiagnosticsOptions: vi.fn(),
    setEagerModelSync: vi.fn(),
  },
}));

vi.mock("monaco-editor", () => ({
  editor: {
    defineTheme: monacoHarness.defineTheme,
  },
  languages: {
    typescript: {
      javascriptDefaults: monacoHarness.javascriptDefaults,
      typescriptDefaults: monacoHarness.typescriptDefaults,
    },
  },
}));

vi.mock("monaco-editor/esm/vs/editor/editor.worker?worker", () => ({
  default: class EditorWorker {},
}));
vi.mock("monaco-editor/esm/vs/language/css/css.worker?worker", () => ({
  default: class CssWorker {},
}));
vi.mock("monaco-editor/esm/vs/language/html/html.worker?worker", () => ({
  default: class HtmlWorker {},
}));
vi.mock("monaco-editor/esm/vs/language/json/json.worker?worker", () => ({
  default: class JsonWorker {},
}));
vi.mock("monaco-editor/esm/vs/language/typescript/ts.worker?worker", () => ({
  default: class TypeScriptWorker {},
}));

describe("configureMonaco", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("self", {});
    monacoHarness.defineTheme.mockClear();
    monacoHarness.javascriptDefaults.setDiagnosticsOptions.mockClear();
    monacoHarness.javascriptDefaults.setEagerModelSync.mockClear();
    monacoHarness.typescriptDefaults.setDiagnosticsOptions.mockClear();
    monacoHarness.typescriptDefaults.setEagerModelSync.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defines canonical light and dark aliases alongside the accent-aware themes", async () => {
    const { configureMonaco } = await import("./monacoSetup");
    configureMonaco();

    const definitions = new Map(
      monacoHarness.defineTheme.mock.calls.map(([name, definition]) => [name, definition]),
    );

    expect(definitions.size).toBe(12);
    expect(definitions.get("trace-light")).toMatchObject({ base: "vs" });
    expect(definitions.get("trace-dark")).toMatchObject({ base: "vs-dark" });
    expect(definitions.get("trace-light-cobalt")).toMatchObject({ base: "vs" });
    expect(definitions.get("trace-dark-rose")).toMatchObject({ base: "vs-dark" });
  });
});
