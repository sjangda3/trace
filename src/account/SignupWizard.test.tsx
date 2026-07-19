// @vitest-environment jsdom

import { forwardRef, useState, type ComponentType } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_SIGNUP_DRAFT,
  SignupWizard,
  clearSignupPasswordFields,
  type SignupDraft,
  type SignupStep,
} from "./SignupWizard";
import type { TracePreferences } from "../preferences/types";
import signupWizardSource from "./SignupWizard.tsx?raw";

interface FileSystemBuiltin {
  readFileSync: (path: URL, encoding: "utf8") => string;
}

const testProcess = (
  globalThis as typeof globalThis & {
    process: { getBuiltinModule: (name: string) => unknown };
  }
).process;
const fileSystem = testProcess.getBuiltinModule("node:fs") as FileSystemBuiltin;
const stylesheetPath = "../styles.css";
const stylesSource = fileSystem.readFileSync(
  new URL(stylesheetPath, import.meta.url),
  "utf8",
);

const motionHarness = vi.hoisted(() => ({ reducedMotion: false }));

vi.mock("@outpacelabs/avatars", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    GradientAvatar: ({ seed, size }: { seed: string | number; size?: number }) => React.createElement("span", {
      "data-testid": "gradient-avatar",
      "data-seed": String(seed),
      "data-size": String(size ?? 32),
      "aria-hidden": "true",
    }),
  };
});

vi.mock("motion/react", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  const MotionDiv = forwardRef<
    HTMLDivElement,
    React.HTMLAttributes<HTMLDivElement> & {
      initial?: unknown;
      animate?: unknown;
      exit?: unknown;
      transition?: unknown;
      onAnimationComplete?: () => void;
    }
  >(function MotionDiv({
    initial: _initial,
    animate: _animate,
    exit: _exit,
    transition: _transition,
    onAnimationComplete: _onAnimationComplete,
    ...props
  }, ref) {
    return <div ref={ref} {...props} />;
  });

  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    motion: { div: MotionDiv },
    useReducedMotion: () => motionHarness.reducedMotion,
    useIsPresent: () => true,
  };
});

const DEFAULT_TEST_PREFERENCES: TracePreferences = {
  appearance: "system",
  accent: "cobalt",
  codeSize: "default",
};

type CurrentSignupWizardProps = React.ComponentProps<typeof SignupWizard>;
const SignupWizardUnderTest = SignupWizard as ComponentType<
  CurrentSignupWizardProps & { canSubmit: boolean }
>;

interface SubmittedPayload {
  draft: SignupDraft;
  preferences: TracePreferences;
}

interface HarnessOptions {
  initialDraft?: Partial<SignupDraft>;
  initialStep?: SignupStep;
  initialPreferences?: TracePreferences;
  busy?: boolean;
  availabilityMessage?: string | null;
  serverError?: string | null;
}

function renderWizard({
  initialDraft = {},
  initialStep = 0,
  initialPreferences = DEFAULT_TEST_PREFERENCES,
  busy = false,
  availabilityMessage = null,
  serverError = null,
}: HarnessOptions = {}) {
  const onDraftChange = vi.fn<(draft: SignupDraft) => void>();
  const onStepChange = vi.fn<(step: SignupStep) => void>();
  const onPreferencesChange = vi.fn<(preferences: TracePreferences) => void>();
  const onSubmit = vi.fn<(payload: SubmittedPayload) => void>();

  function Harness() {
    const [draft, setDraft] = useState<SignupDraft>({
      ...EMPTY_SIGNUP_DRAFT,
      ...initialDraft,
    });
    const [step, setStep] = useState<SignupStep>(initialStep);
    const [preferences, setPreferences] = useState(initialPreferences);

    return (
      <SignupWizardUnderTest
        canSubmit
        draft={draft}
        step={step}
        preferences={preferences}
        resolvedAppearance="light"
        busy={busy}
        availabilityMessage={availabilityMessage}
        serverError={serverError}
        onDraftChange={(next) => {
          onDraftChange(next);
          setDraft(next);
        }}
        onStepChange={(next) => {
          onStepChange(next);
          setStep(next);
        }}
        onPreferencesChange={(next) => {
          onPreferencesChange(next);
          setPreferences(next);
        }}
        onSubmit={() => onSubmit({ draft, preferences })}
      />
    );
  }

  return {
    ...render(<Harness />),
    onDraftChange,
    onPreferencesChange,
    onStepChange,
    onSubmit,
  };
}

function setCarouselGeometry(
  viewport: HTMLElement,
  { scrollWidth = 640, clientWidth = 320 } = {},
) {
  Object.defineProperty(viewport, "scrollWidth", {
    configurable: true,
    value: scrollWidth,
  });
  Object.defineProperty(viewport, "clientWidth", {
    configurable: true,
    value: clientWidth,
  });
}

function installScrollTo(viewport: HTMLElement) {
  const scrollTo = vi.fn((options: ScrollToOptions) => {
    if (typeof options.left === "number") viewport.scrollLeft = options.left;
  });
  Object.defineProperty(viewport, "scrollTo", {
    configurable: true,
    value: scrollTo,
  });
  return scrollTo;
}

function installAvatarOptionGeometry(container: HTMLElement) {
  for (const option of container.querySelectorAll<HTMLElement>(
    ".onboarding-signup-avatar-option",
  )) {
    Object.defineProperty(option, "offsetLeft", {
      configurable: true,
      get: () => 34 + (Number(option.style.order) * 48),
    });
    Object.defineProperty(option, "offsetWidth", {
      configurable: true,
      value: 38,
    });
  }
}

function installPointerCapture(viewport: HTMLElement) {
  const capturedPointers = new Set<number>();
  const setPointerCapture = vi.fn((pointerId: number) => {
    capturedPointers.add(pointerId);
  });
  const hasPointerCapture = vi.fn((pointerId: number) => (
    capturedPointers.has(pointerId)
  ));
  const releasePointerCapture = vi.fn((pointerId: number) => {
    capturedPointers.delete(pointerId);
  });
  Object.defineProperties(viewport, {
    setPointerCapture: { configurable: true, value: setPointerCapture },
    hasPointerCapture: { configurable: true, value: hasPointerCapture },
    releasePointerCapture: { configurable: true, value: releasePointerCapture },
  });
  return { setPointerCapture, hasPointerCapture, releasePointerCapture };
}

function dispatchPointer(
  target: Element,
  type: string,
  init: {
    pointerId: number;
    pointerType: "mouse" | "pen";
    clientX: number;
    button?: number;
  },
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(init)) {
    Object.defineProperty(event, key, { configurable: true, value });
  }
  fireEvent(target, event);
}

function installAnimationFrameHarness() {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    const id = nextId++;
    callbacks.set(id, callback);
    return id;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => {
    callbacks.delete(id);
  }));
  return {
    flush() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      act(() => {
        for (const callback of pending) callback(performance.now());
      });
    },
  };
}

function avatarVisualPosition(input: HTMLInputElement, scrollLeft: number) {
  const option = input.closest<HTMLElement>(".onboarding-signup-avatar-option");
  if (!option) throw new Error("Avatar input has no visual option.");
  return (Number(option.style.order) * 48) - scrollLeft;
}

function cssDeclarations(selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = stylesSource.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, "s"));
  expect(match, `Missing CSS rule for ${selector}`).not.toBeNull();
  return match?.[1] ?? "";
}

afterEach(() => {
  motionHarness.reducedMotion = false;
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SignupWizard", () => {
  it("clears both signup password fields while retaining identity values", () => {
    const draft: SignupDraft = {
      firstName: "Ada",
      lastName: "Lovelace",
      avatarVariant: 11,
      email: "ada@example.com",
      password: "password-for-testing",
      passwordConfirmation: "password-for-testing",
    };

    expect(clearSignupPasswordFields(draft)).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
      avatarVariant: 11,
      email: "ada@example.com",
      password: "",
      passwordConfirmation: "",
    });
  });

  it("validates the active name step and clears local feedback after editing", async () => {
    const user = userEvent.setup();
    const { onStepChange } = renderWizard();
    const form = screen.getByRole("form", {
      name: "Set up your profile",
    });

    fireEvent.submit(form);
    expect(screen.getByRole("alert").textContent).toContain(
      "Enter your first name.",
    );
    expect(screen.getByLabelText("First name").getAttribute("aria-invalid")).toBe("true");
    expect(onStepChange).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("First name"), "Ada");
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Next →" }));
    expect(screen.getByRole("alert").textContent).toContain("Enter your last name.");
    expect(screen.getByLabelText("First name").getAttribute("aria-invalid")).toBeNull();
    expect(screen.getByLabelText("Last name").getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(screen.getByLabelText("Last name"));
    await user.type(screen.getByLabelText("Last name"), "Lovelace");
    await user.click(screen.getByRole("button", { name: "Next →" }));

    expect(onStepChange).toHaveBeenLastCalledWith(1);
    expect(screen.queryByLabelText("Step 2 of 4")).not.toBeNull();
  });

  it("renders four accessible progress bars without visible step-count text", async () => {
    const user = userEvent.setup();
    const { container } = renderWizard({
      initialDraft: { firstName: "Ada", lastName: "Lovelace" },
    });
    const progress = screen.getByRole("progressbar", { name: "Step 1 of 4" });
    const bars = progress.querySelectorAll("ol > li");

    expect(progress.getAttribute("aria-valuemin")).toBe("1");
    expect(progress.getAttribute("aria-valuemax")).toBe("4");
    expect(progress.getAttribute("aria-valuenow")).toBe("1");
    expect(progress.querySelector("ol")?.getAttribute("aria-hidden")).toBe("true");
    expect(bars).toHaveLength(4);
    expect(progress.querySelectorAll("li.is-current")).toHaveLength(1);
    expect(progress.textContent?.trim()).toBe("");
    expect(container.textContent).not.toContain("1 of 4");

    await user.click(screen.getByRole("button", { name: "Next →" }));
    const nextProgress = screen.getByRole("progressbar", { name: "Step 2 of 4" });
    expect(nextProgress).toBe(progress);
    expect(nextProgress.getAttribute("aria-valuenow")).toBe("2");
    expect(nextProgress.querySelectorAll("ol > li")).toHaveLength(4);
    expect(nextProgress.querySelectorAll("li.is-current")).toHaveLength(2);
    expect(nextProgress.textContent?.trim()).toBe("");
    expect(container.textContent).not.toContain("2 of 4");
  });

  it("uses one unique native 12-option radio group with a single tab stop", async () => {
    const user = userEvent.setup();
    renderWizard();
    const picker = screen.getByRole("group", { name: "Choose an avatar" });
    const radios = within(picker).getAllByRole("radio") as HTMLInputElement[];
    const seeds = within(picker).getAllByTestId("gradient-avatar").map(
      (avatar) => avatar.getAttribute("data-seed"),
    );

    expect(radios).toHaveLength(12);
    expect(picker.querySelectorAll('input[name="signup-avatar"]')).toHaveLength(12);
    expect(radios.map((radio) => radio.getAttribute("aria-label"))).toEqual(
      Array.from({ length: 12 }, (_, index) => `Avatar ${index + 1}`),
    );
    expect(radios.map((radio) => radio.value)).toEqual(
      Array.from({ length: 12 }, (_, index) => String(index)),
    );
    expect(radios.every((radio) => radio.type === "radio")).toBe(true);
    expect(radios.every((radio) => radio.name === "signup-avatar")).toBe(true);
    expect(radios.filter((radio) => radio.checked)).toEqual([radios[0]]);
    expect(new Set(radios)).toHaveProperty("size", 12);
    expect(seeds).toHaveLength(12);
    expect(new Set(seeds)).toHaveProperty("size", 12);

    screen.getByLabelText("Last name").focus();
    await user.tab();
    expect(document.activeElement).toBe(radios[0]);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Next →" }));
  });

  it("wraps keyboard selection and supports Home and End", async () => {
    const { onDraftChange } = renderWizard();
    const first = screen.getByRole("radio", { name: "Avatar 1" }) as HTMLInputElement;
    const last = screen.getByRole("radio", { name: "Avatar 12" }) as HTMLInputElement;

    first.focus();
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    await waitFor(() => expect(last.checked).toBe(true));
    expect(document.activeElement).toBe(last);
    expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ avatarVariant: 11 }));

    fireEvent.keyDown(last, { key: "Home" });
    await waitFor(() => expect(first.checked).toBe(true));
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: "End" });
    await waitFor(() => expect(last.checked).toBe(true));
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(last, { key: "ArrowRight" });
    await waitFor(() => expect(first.checked).toBe(true));
    expect(document.activeElement).toBe(first);
  });

  it.each(["mouse", "pen"] as const)(
    "drags with a %s pointer, captures it, and suppresses the release click",
    (pointerType) => {
      installAnimationFrameHarness();
      const { onDraftChange } = renderWizard();
      const viewport = screen.getByTestId("signup-avatar-viewport");
      const capture = installPointerCapture(viewport);
      viewport.scrollLeft = 120;

      dispatchPointer(viewport, "pointerdown", {
        pointerId: 7,
        pointerType,
        clientX: 140,
        button: 0,
      });
      expect(capture.setPointerCapture).toHaveBeenCalledWith(7);

      dispatchPointer(viewport, "pointermove", {
        pointerId: 7,
        pointerType,
        clientX: 100,
      });
      expect(viewport.scrollLeft).toBe(160);
      expect(viewport.getAttribute("data-dragging")).toBe("true");

      dispatchPointer(viewport, "pointerup", {
        pointerId: 7,
        pointerType,
        clientX: 100,
      });
      expect(capture.hasPointerCapture).toHaveBeenCalledWith(7);
      expect(capture.releasePointerCapture).toHaveBeenCalledWith(7);
      expect(viewport.getAttribute("data-dragging")).toBe("false");

      const clickWasAllowed = fireEvent.click(
        screen.getByRole("radio", { name: "Avatar 12" }),
      );
      expect(clickWasAllowed).toBe(false);
      expect(onDraftChange).not.toHaveBeenCalled();
    },
  );

  it("rebases at both scroll boundaries without cloning controls or moving the visual anchor", () => {
    const animationFrames = installAnimationFrameHarness();
    renderWizard();
    const viewport = screen.getByTestId("signup-avatar-viewport");
    setCarouselGeometry(viewport);
    const originalRadios = screen.getAllByRole("radio", { name: /^Avatar / }) as HTMLInputElement[];
    const anchor = originalRadios[0];

    viewport.scrollLeft = 0;
    const beforeLeftRebase = avatarVisualPosition(anchor, viewport.scrollLeft);
    fireEvent.scroll(viewport);
    expect(viewport.scrollLeft).toBe(48);
    expect(avatarVisualPosition(anchor, viewport.scrollLeft)).toBe(beforeLeftRebase);
    expect(screen.getAllByRole("radio", { name: /^Avatar / })).toHaveLength(12);
    for (const [index, radio] of originalRadios.entries()) {
      expect(screen.getByRole("radio", { name: `Avatar ${index + 1}` })).toBe(radio);
    }

    animationFrames.flush();
    viewport.scrollLeft = 320;
    const beforeRightRebase = avatarVisualPosition(anchor, viewport.scrollLeft);
    fireEvent.scroll(viewport);
    expect(viewport.scrollLeft).toBe(272);
    expect(avatarVisualPosition(anchor, viewport.scrollLeft)).toBe(beforeRightRebase);
    expect(screen.getAllByRole("radio", { name: /^Avatar / })).toHaveLength(12);
    for (const [index, radio] of originalRadios.entries()) {
      expect(screen.getByRole("radio", { name: `Avatar ${index + 1}` })).toBe(radio);
    }
  });

  it.each([
    { reducedMotion: false, behavior: "smooth" },
    { reducedMotion: true, behavior: "auto" },
  ] as const)(
    "centers keyboard focus with $behavior scrolling when reduced motion is $reducedMotion",
    async ({ reducedMotion, behavior }) => {
      motionHarness.reducedMotion = reducedMotion;
      const { container } = renderWizard();
      const viewport = screen.getByTestId("signup-avatar-viewport");
      setCarouselGeometry(viewport);
      installAvatarOptionGeometry(container);
      const scrollTo = installScrollTo(viewport);

      fireEvent.focus(screen.getByRole("radio", { name: "Avatar 8" }));

      await waitFor(() => expect(scrollTo).toHaveBeenLastCalledWith({
        left: 181,
        behavior,
      }));
    },
  );

  it("ignores smooth-centering scroll frames until the user interrupts", () => {
    const animationFrames = installAnimationFrameHarness();
    const { container } = renderWizard();
    const viewport = screen.getByTestId("signup-avatar-viewport");
    setCarouselGeometry(viewport);
    installAvatarOptionGeometry(container);
    installScrollTo(viewport);
    const edgeAvatar = screen.getByRole("radio", { name: "Avatar 7" });

    fireEvent.focus(edgeAvatar);
    const ordersAfterFocus = [...container.querySelectorAll<HTMLElement>(
      ".onboarding-signup-avatar-option",
    )].map((option) => option.style.order);
    animationFrames.flush();

    viewport.scrollLeft = 320;
    fireEvent.scroll(viewport);
    expect([...container.querySelectorAll<HTMLElement>(
      ".onboarding-signup-avatar-option",
    )].map((option) => option.style.order)).toEqual(ordersAfterFocus);

    fireEvent.wheel(viewport, { deltaX: 20 });
    fireEvent.scroll(viewport);
    expect(viewport.scrollLeft).toBe(272);
  });

  it("serializes a boundary rebase with a batched focus-centering request", () => {
    const animationFrames = installAnimationFrameHarness();
    const { container } = renderWizard();
    const viewport = screen.getByTestId("signup-avatar-viewport");
    setCarouselGeometry(viewport);
    installAvatarOptionGeometry(container);
    let scrollLeft = 0;
    const scrollHistory: number[] = [];
    Object.defineProperty(viewport, "scrollLeft", {
      configurable: true,
      get: () => scrollLeft,
      set: (next: number) => {
        scrollLeft = next;
        scrollHistory.push(next);
      },
    });
    installScrollTo(viewport);
    const focusedAvatar = screen.getByRole("radio", { name: "Avatar 8" });

    act(() => {
      viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
      focusedAvatar.focus();
    });

    expect(focusedAvatar.closest<HTMLElement>(".onboarding-signup-avatar-option")?.style.order)
      .toBe("6");
    expect(scrollHistory).toContain(240);
    expect(scrollHistory.at(-1)).toBe(181);

    animationFrames.flush();
    fireEvent.wheel(viewport, { deltaX: 20 });
    viewport.scrollLeft = 320;
    fireEvent.scroll(viewport);
    expect(viewport.scrollLeft).toBe(272);
  });

  it("does not auto-scroll or change the selected avatar over time", () => {
    vi.useFakeTimers();
    const { container, onDraftChange } = renderWizard({
      initialDraft: { avatarVariant: 5 },
    });
    const viewport = screen.getByTestId("signup-avatar-viewport");
    viewport.scrollLeft = 144;
    const initialOrders = [...container.querySelectorAll<HTMLElement>(
      ".onboarding-signup-avatar-option",
    )].map((option) => option.style.order);

    act(() => vi.advanceTimersByTime(60_000));

    expect(viewport.scrollLeft).toBe(144);
    expect([...container.querySelectorAll<HTMLElement>(
      ".onboarding-signup-avatar-option",
    )].map((option) => option.style.order)).toEqual(initialOrders);
    expect((screen.getByRole("radio", { name: "Avatar 6" }) as HTMLInputElement).checked)
      .toBe(true);
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("defines a clipped container, hidden native scrollbar, two edge fades, and halo-safe padding", () => {
    const containerRule = cssDeclarations(".onboarding-signup-avatar-carousel");
    const viewportRule = cssDeclarations(".onboarding-signup-avatar-viewport");
    const scrollbarRule = cssDeclarations(
      ".onboarding-signup-avatar-viewport::-webkit-scrollbar",
    );
    const trackRule = cssDeclarations(".onboarding-signup-avatar-track");
    const selectedRule = cssDeclarations(".onboarding-signup-avatar-option.is-selected");

    expect(containerRule).toMatch(/overflow:\s*hidden/);
    expect(containerRule).toMatch(/border:\s*1px solid/);
    expect(containerRule).toMatch(/border-radius:\s*10px/);
    expect(viewportRule).toMatch(/overflow-x:\s*auto/);
    expect(viewportRule).toMatch(/scrollbar-width:\s*none/);
    expect(viewportRule).toMatch(/scroll-padding-inline:\s*34px/);
    expect(viewportRule).toMatch(/touch-action:\s*pan-x/);
    expect(viewportRule).toMatch(/-webkit-mask-image:\s*linear-gradient/);
    expect(viewportRule).toMatch(/mask-image:\s*linear-gradient/);
    expect(viewportRule).toMatch(/transparent 0/);
    expect(viewportRule).toMatch(/#000 28px/);
    expect(viewportRule).toMatch(/#000 calc\(100% - 28px\)/);
    expect(viewportRule).toMatch(/transparent 100%/);
    expect(scrollbarRule).toMatch(/display:\s*none/);
    expect(trackRule).toMatch(/padding:\s*7px 34px/);
    expect(selectedRule).toMatch(/0 0 0 4px/);
  });

  it("updates the composed profile preview and selected generated avatar", async () => {
    const user = userEvent.setup();
    const { container, onDraftChange } = renderWizard();

    await user.type(screen.getByLabelText("First name"), "Ada");
    await user.type(screen.getByLabelText("Last name"), "Lovelace");
    expect(screen.getByText("Ada Lovelace")).not.toBeNull();

    const avatar = screen.getByRole("radio", { name: "Avatar 12" });
    await user.click(avatar);

    expect((avatar as HTMLInputElement).checked).toBe(true);
    expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({
      firstName: "Ada",
      lastName: "Lovelace",
      avatarVariant: 11,
    }));
    expect(
      container.querySelector(".onboarding-signup-avatar-preview-stage [data-seed]")
        ?.getAttribute("data-seed"),
    ).toBe("trace-avatar:11");
  });

  it("enforces the email and password rules before advancing", async () => {
    const user = userEvent.setup();
    const { onStepChange } = renderWizard({
      initialStep: 1,
      initialDraft: { email: "not-an-email" },
    });

    fireEvent.submit(screen.getByRole("form"));
    expect(screen.getByRole("alert").textContent).toContain(
      "Enter a valid email address.",
    );
    expect(onStepChange).not.toHaveBeenCalled();

    const email = screen.getByLabelText("Email");
    await user.clear(email);
    await user.type(email, "ada@example.com");
    await user.click(screen.getByRole("button", { name: "Next →" }));
    expect(onStepChange).toHaveBeenLastCalledWith(2);

    const password = screen.getByLabelText("Password");
    const confirmation = screen.getByLabelText("Confirm password");
    await user.type(password, "too-short");
    fireEvent.submit(screen.getByRole("form"));
    expect(screen.getByRole("alert").textContent).toContain(
      "Your password must be at least 12 characters.",
    );

    await user.clear(password);
    await user.type(password, "twelve-chars!");
    await user.type(confirmation, "different-value");
    fireEvent.submit(screen.getByRole("form"));
    expect(screen.getByRole("alert").textContent).toContain(
      "The passwords do not match.",
    );

    await user.clear(confirmation);
    await user.type(confirmation, "twelve-chars!");
    await user.click(screen.getByRole("button", { name: "Next →" }));
    expect(onStepChange).toHaveBeenLastCalledWith(3);
    expect(screen.queryByLabelText("Step 4 of 4")).not.toBeNull();
  });

  it("uses native identity, email, and new-password input semantics", async () => {
    const nameView = renderWizard();
    const firstName = screen.getByLabelText("First name") as HTMLInputElement;
    const lastName = screen.getByLabelText("Last name") as HTMLInputElement;
    expect(firstName.name).toBe("given-name");
    expect(firstName.required).toBe(true);
    expect(firstName.maxLength).toBe(80);
    expect(firstName.autocomplete).toBe("given-name");
    expect(lastName.name).toBe("family-name");
    expect(lastName.required).toBe(true);
    expect(lastName.maxLength).toBe(80);
    expect(lastName.autocomplete).toBe("family-name");
    nameView.unmount();

    const emailView = renderWizard({ initialStep: 1 });
    const email = screen.getByLabelText("Email") as HTMLInputElement;
    expect(email.name).toBe("email");
    expect(email.type).toBe("email");
    expect(email.required).toBe(true);
    expect(email.inputMode).toBe("email");
    expect(email.autocomplete).toBe("email");
    expect(email.getAttribute("autocapitalize")).toBe("none");
    expect(email.getAttribute("spellcheck")).toBe("false");
    emailView.unmount();

    renderWizard({ initialStep: 2 });
    const password = screen.getByLabelText("Password") as HTMLInputElement;
    const confirmation = screen.getByLabelText(
      "Confirm password",
    ) as HTMLInputElement;
    for (const input of [password, confirmation]) {
      expect(input.required).toBe(true);
      expect(input.type).toBe("password");
      expect(input.minLength).toBe(12);
      expect(input.maxLength).toBe(1024);
      expect(input.autocomplete).toBe("new-password");
    }
    expect(password.name).toBe("new-password");
    expect(confirmation.name).toBe("new-password-confirmation");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Show passwords" }));
    expect(password.type).toBe("text");
    expect(confirmation.type).toBe("text");
    await user.click(screen.getByRole("button", { name: "Hide passwords" }));
    expect(password.type).toBe("password");
    expect(confirmation.type).toBe("password");
  });

  it("moves forward and back without treating Back as a submission", async () => {
    const user = userEvent.setup();
    const { onStepChange, onSubmit } = renderWizard({
      initialDraft: { firstName: "Ada", lastName: "Lovelace" },
    });

    await user.click(screen.getByRole("button", { name: "Next →" }));
    expect(screen.queryByLabelText("Step 2 of 4")).not.toBeNull();
    const back = screen.getByRole("button", { name: "← Back" });
    expect(back.getAttribute("type")).toBe("button");
    await user.click(back);

    expect(onStepChange.mock.calls).toEqual([[1], [0]]);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Step 1 of 4")).not.toBeNull();
  });

  it("keeps one fixed signup frame while steps crossfade in place", async () => {
    const user = userEvent.setup();
    const { container } = renderWizard({
      initialDraft: { firstName: "Ada", lastName: "Lovelace" },
    });
    const form = screen.getByRole("form", {
      name: "Set up your profile",
    });
    const stage = container.querySelector(".onboarding-signup-step-stage");
    const feedbackSlot = container.querySelector(".onboarding-signup-feedback-slot");

    expect(stage).not.toBeNull();
    expect(feedbackSlot).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Next →" }));

    expect(screen.getByRole("form", {
      name: "Where should we send your link?",
    })).toBe(form);
    expect(container.querySelector(".onboarding-signup-step-stage")).toBe(stage);
    expect(form.classList.contains("onboarding-signup-form")).toBe(true);
    expect(feedbackSlot?.classList.contains("onboarding-signup-feedback-slot"))
      .toBe(true);
    expect(signupWizardSource).toContain('mode="sync"');
    expect(signupWizardSource).not.toMatch(/\bx:\s*[+-]?8/);
  });

  it("emits complete controlled records and submits the final draft and preferences", async () => {
    const user = userEvent.setup();
    const draft: SignupDraft = {
      firstName: "Ada",
      lastName: "Lovelace",
      avatarVariant: 2,
      email: "ada@example.com",
      password: "twelve-chars!",
      passwordConfirmation: "twelve-chars!",
    };
    const {
      container,
      onPreferencesChange,
      onSubmit,
    } = renderWizard({ initialDraft: draft, initialStep: 3 });

    await user.click(screen.getByRole("radio", { name: /^Dark/ }));
    await user.click(screen.getByRole("radio", { name: "Rose" }));
    await user.click(screen.getByRole("radio", { name: "Large code" }));
    expect(onPreferencesChange).toHaveBeenLastCalledWith({
      appearance: "dark",
      accent: "rose",
      codeSize: "large",
    });
    expect(
      container.querySelector(".onboarding-signup-workspace-preview__surface")
        ?.className,
    ).toContain("is-dark is-large is-accent-rose");

    await user.click(screen.getByRole("button", { name: "Create account →" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      draft,
      preferences: {
        appearance: "dark",
        accent: "rose",
        codeSize: "large",
      },
    });
  });
});
