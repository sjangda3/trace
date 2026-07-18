// @vitest-environment jsdom

import { act, useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { PreferencesDialog } from "./PreferencesDialog";
import type { TracePreferences } from "./types";

const preferences: TracePreferences = {
  appearance: "system",
  accent: "cobalt",
  codeSize: "default",
};

const dialogPrototype = HTMLDialogElement.prototype;
const originalShowModal = Object.getOwnPropertyDescriptor(
  dialogPrototype,
  "showModal",
);
const originalClose = Object.getOwnPropertyDescriptor(dialogPrototype, "close");

let showModal: Mock;
let close: Mock;

function restorePrototypeProperty(
  name: "showModal" | "close",
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) Object.defineProperty(dialogPrototype, name, descriptor);
  else delete dialogPrototype[name];
}

function disableNativeDialogMethods() {
  Object.defineProperty(dialogPrototype, "showModal", {
    configurable: true,
    value: undefined,
  });
  Object.defineProperty(dialogPrototype, "close", {
    configurable: true,
    value: undefined,
  });
}

function dialogProps(overrides: Partial<React.ComponentProps<
  typeof PreferencesDialog
>> = {}): React.ComponentProps<typeof PreferencesDialog> {
  return {
    open: true,
    preferences,
    resolvedAppearance: "light",
    saveError: null,
    onPreferencesChange: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

function createOpener() {
  const opener = document.createElement("button");
  opener.type = "button";
  opener.textContent = "Open preferences";
  opener.dataset.preferencesTestOpener = "true";
  document.body.append(opener);
  opener.focus();
  return opener;
}

function ControlledDialog({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <PreferencesDialog
      {...dialogProps()}
      open={open}
      onClose={() => {
        onClose();
        setOpen(false);
      }}
    />
  );
}

beforeEach(() => {
  showModal = vi.fn(function showModalPolyfill(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  });
  close = vi.fn(function closePolyfill(this: HTMLDialogElement) {
    if (!this.open) return;
    this.removeAttribute("open");
    queueMicrotask(() => this.dispatchEvent(new Event("close")));
  });
  Object.defineProperty(dialogPrototype, "showModal", {
    configurable: true,
    value: showModal,
  });
  Object.defineProperty(dialogPrototype, "close", {
    configurable: true,
    value: close,
  });
});

afterEach(() => {
  cleanup();
  document.querySelectorAll("[data-preferences-test-opener]")
    .forEach((element) => element.remove());
  restorePrototypeProperty("showModal", originalShowModal);
  restorePrototypeProperty("close", originalClose);
  vi.restoreAllMocks();
});

describe("PreferencesDialog", () => {
  it("opens natively, labels the dialog, focuses its heading, and closes on prop change", async () => {
    const opener = createOpener();
    const props = dialogProps();
    const view = render(<PreferencesDialog {...props} />);
    const dialog = screen.getByRole("dialog", { name: "Preferences" });

    expect(showModal).toHaveBeenCalledTimes(1);
    expect(dialog.hasAttribute("open")).toBe(true);
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { name: "Preferences" }),
      );
    });

    view.rerender(<PreferencesDialog {...props} open={false} />);
    expect(close).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("falls back to the reflected open attribute without dialog methods", async () => {
    disableNativeDialogMethods();
    const props = dialogProps();
    const view = render(<PreferencesDialog {...props} />);
    const dialog = screen.getByRole("dialog", { name: "Preferences" });

    expect(dialog.hasAttribute("open")).toBe(true);
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { name: "Preferences" }),
      );
    });

    view.rerender(<PreferencesDialog {...props} open={false} />);
    expect(dialog.hasAttribute("open")).toBe(false);
  });

  it("forwards complete records from the shared appearance controls", async () => {
    const user = userEvent.setup();
    const onPreferencesChange = vi.fn();
    render(
      <PreferencesDialog
        {...dialogProps({ onPreferencesChange })}
      />,
    );

    await user.click(screen.getByRole("radio", { name: /^Dark/ }));
    expect(onPreferencesChange).toHaveBeenLastCalledWith({
      appearance: "dark",
      accent: "cobalt",
      codeSize: "default",
    });
  });

  it("treats native Escape cancellation as a close signal and restores focus", async () => {
    const opener = createOpener();
    const onClose = vi.fn();
    render(<ControlledDialog onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "Preferences" });
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { name: "Preferences" }),
      );
    });

    // Browsers translate Escape on a modal dialog into a cancel event. jsdom
    // lacks that behavior, so dispatch the native event the component receives.
    const cancelEvent = new Event("cancel", { cancelable: true });
    act(() => {
      dialog.dispatchEvent(cancelEvent);
    });

    expect(cancelEvent.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("uses Done as a close signal and restores focus to the opener", async () => {
    const user = userEvent.setup();
    const opener = createOpener();
    const onClose = vi.fn();
    render(<ControlledDialog onClose={onClose} />);
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { name: "Preferences" }),
      );
    });

    await user.click(screen.getByRole("button", { name: "Done" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("reports an external native close exactly once", async () => {
    const opener = createOpener();
    const onClose = vi.fn();
    render(<ControlledDialog onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "Preferences" });
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { name: "Preferences" }),
      );
    });

    act(() => {
      dialog.dispatchEvent(new Event("close"));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});
