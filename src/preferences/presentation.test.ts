import { describe, expect, it } from "vitest";
import {
  baseMonacoThemeName,
  editorMetrics,
  monacoThemeName,
  terminalMetrics,
} from "./presentation";

describe("preference presentation mappings", () => {
  it("keeps the specified editor and terminal code-size mappings", () => {
    expect(editorMetrics("small")).toEqual({ fontSize: 13, lineHeight: 19 });
    expect(editorMetrics("default")).toEqual({ fontSize: 14, lineHeight: 20 });
    expect(editorMetrics("large")).toEqual({ fontSize: 16, lineHeight: 23 });
    expect(terminalMetrics("small")).toEqual({ fontSize: 11, lineHeight: 1.45 });
    expect(terminalMetrics("default")).toEqual({ fontSize: 12, lineHeight: 1.45 });
    expect(terminalMetrics("large")).toEqual({ fontSize: 14, lineHeight: 1.45 });
  });

  it("retains canonical light and dark Monaco theme names alongside accent variants", () => {
    expect(baseMonacoThemeName("light")).toBe("trace-light");
    expect(baseMonacoThemeName("dark")).toBe("trace-dark");
    expect(monacoThemeName("light", "violet")).toBe("trace-light-violet");
    expect(monacoThemeName("dark", "rose")).toBe("trace-dark-rose");
  });
});
