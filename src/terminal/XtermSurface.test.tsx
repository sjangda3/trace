// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { TerminalSession } from "./types";
import { terminalPalette } from "../preferences/presentation";
import { XtermSurface } from "./XtermSurface";

const xtermHarness = vi.hoisted(() => {
  const terminalConstruct = vi.fn();
  const terminalInstances: FakeTerminal[] = [];
  const fitInstances: FakeFitAddon[] = [];

  class FakeTerminal {
    options: Record<string, unknown>;
    dispose = vi.fn();
    focus = vi.fn();
    loadAddon = vi.fn();
    onData = vi.fn();
    onResize = vi.fn();
    open = vi.fn();
    write = vi.fn();

    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      this.onData.mockReturnValue({ dispose: vi.fn() });
      this.onResize.mockReturnValue({ dispose: vi.fn() });
      this.write.mockImplementation((_data: string, callback?: () => void) => callback?.());
      terminalConstruct(options);
      terminalInstances.push(this);
    }
  }

  class FakeFitAddon {
    fit = vi.fn();

    constructor() {
      fitInstances.push(this);
    }
  }

  return {
    FakeFitAddon,
    FakeTerminal,
    fitInstances,
    terminalConstruct,
    terminalInstances,
  };
});

const apiHarness = vi.hoisted(() => ({
  ack: vi.fn(),
  attach: vi.fn(),
  onEvent: vi.fn(),
  resize: vi.fn(),
  write: vi.fn(),
}));

vi.mock("@xterm/xterm", () => ({ Terminal: xtermHarness.FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: xtermHarness.FakeFitAddon }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("./api", () => ({ terminalApi: apiHarness }));

const session: TerminalSession = {
  id: "terminal-a",
  workspaceId: "workspace-a",
  title: "zsh",
  cols: 80,
  rows: 24,
  createdAt: 0,
  exited: false,
  exitCode: null,
  signal: null,
  output: "",
  sequence: 0,
  control: {
    ownerId: "local",
    ownerName: "You",
    typingCount: 0,
    localHasControl: true,
    version: 1,
  },
};

describe("XtermSurface preference updates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    xtermHarness.terminalInstances.length = 0;
    xtermHarness.fitInstances.length = 0;
    apiHarness.attach.mockResolvedValue(session);
    apiHarness.onEvent.mockReturnValue(() => undefined);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("updates the existing terminal palette and metrics, then refits without remounting", () => {
    const onError = vi.fn();
    const view = render(
      <XtermSurface
        accent="cobalt"
        active
        codeSize="default"
        drawerOpen
        onError={onError}
        pendingAction={null}
        resolvedAppearance="light"
        session={session}
      />,
    );

    expect(xtermHarness.terminalConstruct).toHaveBeenCalledTimes(1);
    expect(xtermHarness.terminalInstances).toHaveLength(1);
    expect(xtermHarness.fitInstances).toHaveLength(1);
    const originalTerminal = xtermHarness.terminalInstances[0];
    const fitAddon = xtermHarness.fitInstances[0];

    // Isolate the preference change from initial setup and drawer-open fitting.
    fitAddon.fit.mockClear();

    view.rerender(
      <XtermSurface
        accent="rose"
        active
        codeSize="large"
        drawerOpen
        onError={onError}
        pendingAction={null}
        resolvedAppearance="dark"
        session={session}
      />,
    );

    expect(xtermHarness.terminalConstruct).toHaveBeenCalledTimes(1);
    expect(xtermHarness.terminalInstances[0]).toBe(originalTerminal);
    expect(originalTerminal.options.theme).toEqual(terminalPalette("dark", "rose"));
    expect(originalTerminal.options.fontSize).toBe(14);
    expect(originalTerminal.options.lineHeight).toBe(1.45);
    expect(fitAddon.fit).toHaveBeenCalledTimes(1);
    expect(originalTerminal.dispose).not.toHaveBeenCalled();
  });
});
