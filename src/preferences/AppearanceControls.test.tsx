// @vitest-environment jsdom

import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppearanceControls } from "./AppearanceControls";
import type { ResolvedAppearance, TracePreferences } from "./types";

const initialPreferences: TracePreferences = {
  appearance: "system",
  accent: "cobalt",
  codeSize: "default",
};

function ControlledAppearanceControls({
  resolvedAppearance = "light",
  onChange = () => undefined,
}: {
  resolvedAppearance?: ResolvedAppearance;
  onChange?: (next: TracePreferences) => void;
}) {
  const [value, setValue] = useState(initialPreferences);
  return (
    <AppearanceControls
      value={value}
      resolvedAppearance={resolvedAppearance}
      onChange={(next) => {
        onChange(next);
        setValue(next);
      }}
    />
  );
}

afterEach(cleanup);

describe("AppearanceControls", () => {
  it("renders and selects every curated appearance, accent, and code-size choice", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(next: TracePreferences) => void>();
    render(<ControlledAppearanceControls onChange={onChange} />);
    expect(screen.getAllByRole("radio")).toHaveLength(11);

    let expected = initialPreferences;
    const select = async (
      name: RegExp | string,
      update: Partial<TracePreferences>,
    ) => {
      const radio = screen.getByRole("radio", { name }) as HTMLInputElement;
      await user.click(radio);
      expected = { ...expected, ...update };
      expect(radio.checked).toBe(true);
      expect(onChange).toHaveBeenLastCalledWith(expected);
    };

    for (const [name, appearance] of [
      [/^Light/, "light"],
      [/^Dark/, "dark"],
      [/^System/, "system"],
    ] as const) {
      await select(name, { appearance });
    }
    for (const accent of ["cobalt", "violet", "teal", "amber", "rose"] as const) {
      await select(new RegExp(`^${accent}`, "i"), { accent });
    }
    for (const [name, codeSize] of [
      ["Small code", "small"],
      ["Default code", "default"],
      ["Large code", "large"],
    ] as const) {
      await select(name, { codeSize });
    }
  });

  it("makes the System preview follow the resolved macOS appearance", () => {
    const view = render(
      <AppearanceControls
        value={initialPreferences}
        resolvedAppearance="light"
        onChange={() => undefined}
      />,
    );
    const previewForSystem = () => {
      const systemRadio = screen.getByRole("radio", { name: /^System/ });
      const preview = systemRadio.closest("label")?.querySelector(
        ".appearance-code-preview",
      );
      expect(preview).not.toBeNull();
      return preview!;
    };

    expect(previewForSystem().classList.contains("is-light")).toBe(true);
    view.rerender(
      <AppearanceControls
        value={initialPreferences}
        resolvedAppearance="dark"
        onChange={() => undefined}
      />,
    );
    expect(previewForSystem().classList.contains("is-dark")).toBe(true);
  });
});
