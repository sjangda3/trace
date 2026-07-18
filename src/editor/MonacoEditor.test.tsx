// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MonacoEditor } from "./MonacoEditor";

const harness = vi.hoisted(() => ({
  configureMonaco: vi.fn(),
  create: vi.fn(),
  getModels: vi.fn(),
  setTheme: vi.fn(),
  editor: {
    createDecorationsCollection: vi.fn(),
    dispose: vi.fn(),
    onDidChangeCursorPosition: vi.fn(),
    onDidChangeModelContent: vi.fn(),
    setModel: vi.fn(),
    updateOptions: vi.fn(),
  },
}));

vi.mock("./monacoSetup", () => ({
  configureMonaco: harness.configureMonaco,
  monaco: {
    Uri: { from: vi.fn() },
    editor: {
      create: harness.create,
      getModels: harness.getModels,
      setTheme: harness.setTheme,
    },
  },
}));

describe("MonacoEditor preference updates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.create.mockReturnValue(harness.editor);
    harness.getModels.mockReturnValue([]);
    harness.editor.createDecorationsCollection.mockReturnValue({
      clear: vi.fn(),
      set: vi.fn(),
    });
    harness.editor.onDidChangeCursorPosition.mockReturnValue({ dispose: vi.fn() });
    harness.editor.onDidChangeModelContent.mockReturnValue({ dispose: vi.fn() });
  });

  afterEach(() => {
    cleanup();
  });

  it("updates the existing editor's theme and metrics without recreating it", () => {
    const onChange = vi.fn();
    const view = render(
      <MonacoEditor
        accent="cobalt"
        activePath={null}
        codeSize="default"
        language="typescript"
        onChange={onChange}
        openPaths={[]}
        resolvedAppearance="light"
        value="const initial = true;"
        workspaceId="workspace-a"
      />,
    );

    expect(harness.create).toHaveBeenCalledTimes(1);
    const originalEditor = harness.create.mock.results[0]?.value;

    // Isolate the preference change from the initial editor configuration.
    harness.setTheme.mockClear();
    harness.editor.updateOptions.mockClear();

    view.rerender(
      <MonacoEditor
        accent="violet"
        activePath={null}
        codeSize="large"
        language="typescript"
        onChange={onChange}
        openPaths={[]}
        resolvedAppearance="dark"
        value="const initial = true;"
        workspaceId="workspace-a"
      />,
    );

    expect(harness.create).toHaveBeenCalledTimes(1);
    expect(harness.create.mock.results[0]?.value).toBe(originalEditor);
    expect(harness.setTheme).toHaveBeenCalledWith("trace-dark-violet");
    expect(harness.editor.updateOptions).toHaveBeenCalledWith({
      fontSize: 16,
      lineHeight: 23,
    });
    expect(harness.editor.dispose).not.toHaveBeenCalled();
  });
});
