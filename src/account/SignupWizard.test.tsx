// @vitest-environment jsdom

import { forwardRef, useState, type ComponentType } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
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
    useReducedMotion: () => true,
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

afterEach(cleanup);

describe("SignupWizard", () => {
  it("clears both signup password fields while retaining identity values", () => {
    const draft: SignupDraft = {
      displayName: "Ada Lovelace",
      email: "ada@example.com",
      password: "password-for-testing",
      passwordConfirmation: "password-for-testing",
    };

    expect(clearSignupPasswordFields(draft)).toEqual({
      displayName: "Ada Lovelace",
      email: "ada@example.com",
      password: "",
      passwordConfirmation: "",
    });
  });

  it("validates the active name step and clears local feedback after editing", async () => {
    const user = userEvent.setup();
    const { onStepChange } = renderWizard();
    const form = screen.getByRole("form", {
      name: "What should teammates call you?",
    });

    fireEvent.submit(form);
    expect(screen.getByRole("alert").textContent).toContain(
      "Enter the name your teammates know you by.",
    );
    expect(screen.getByLabelText("Name").getAttribute("aria-invalid")).toBe("true");
    expect(onStepChange).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Name"), "Ada Lovelace");
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Next →" }));

    expect(onStepChange).toHaveBeenLastCalledWith(1);
    expect(screen.queryByLabelText("Step 2 of 4")).not.toBeNull();
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
    const name = screen.getByLabelText("Name") as HTMLInputElement;
    expect(name.name).toBe("name");
    expect(name.required).toBe(true);
    expect(name.maxLength).toBe(80);
    expect(name.autocomplete).toBe("name");
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
      initialDraft: { displayName: "Ada" },
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
    const { container } = renderWizard({ initialDraft: { displayName: "Ada" } });
    const form = screen.getByRole("form", {
      name: "What should teammates call you?",
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
      displayName: "Ada Lovelace",
      email: "ada@example.com",
      password: "twelve-chars!",
      passwordConfirmation: "twelve-chars!",
    };
    const {
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
