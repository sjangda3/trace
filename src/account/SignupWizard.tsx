import {
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
} from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppearanceControls } from "../preferences/AppearanceControls";
import type { ResolvedAppearance, TracePreferences } from "../preferences/types";

export type SignupStep = 0 | 1 | 2 | 3;

export type SignupDraft = {
  displayName: string;
  email: string;
  password: string;
  passwordConfirmation: string;
};

export const EMPTY_SIGNUP_DRAFT: SignupDraft = {
  displayName: "",
  email: "",
  password: "",
  passwordConfirmation: "",
};

export function clearSignupPasswordFields(draft: SignupDraft): SignupDraft {
  return {
    ...draft,
    password: "",
    passwordConfirmation: "",
  };
}

const stepCopy = [
  {
    title: "What should teammates call you?",
    detail: "This is the name Trace will show alongside your work.",
  },
  {
    title: "Where should we send your link?",
    detail: "We’ll send a verification link to this address.",
  },
  {
    title: "Create a password",
    detail: "Use at least 12 characters, then confirm it below.",
  },
  {
    title: "Make Trace yours",
    detail: "Choose how Trace looks on this Mac. You can change this later in Preferences.",
  },
] as const;

function SignupStepView({
  children,
  onEntered,
  reducedMotion,
}: {
  children: ReactNode;
  onEntered: () => void;
  reducedMotion: boolean;
}) {
  const isPresent = useIsPresent();

  return (
    <motion.div
      className="onboarding-signup-step"
      data-present={isPresent ? "true" : "false"}
      inert={isPresent ? undefined : true}
      aria-hidden={isPresent ? undefined : true}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={reducedMotion ? { duration: 0.02 } : { duration: 0.14, ease: "easeOut" }}
      onAnimationComplete={() => {
        if (isPresent) onEntered();
      }}
    >
      {children}
    </motion.div>
  );
}

function initials(value: string) {
  const parts = value.trim().split(/\s+/u).filter(Boolean);
  if (parts.length === 0) return "T";
  const first = parts[0]?.[0] ?? "T";
  const last = parts.length > 1 ? parts.at(-1)?.[0] ?? "" : "";
  return `${first}${last}`.toLocaleUpperCase();
}

function validationMessage(step: SignupStep, draft: SignupDraft) {
  if (step === 0) {
    const name = draft.displayName.trim();
    if (!name) return "Enter the name your teammates know you by.";
    if (name.length > 80) return "Your name must be 80 characters or fewer.";
    return null;
  }
  if (step === 1) {
    if (!draft.email.trim()) return "Enter your email address.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(draft.email.trim())) {
      return "Enter a valid email address.";
    }
    return null;
  }
  if (step === 2) {
    if (draft.password.length < 12) return "Your password must be at least 12 characters.";
    if (draft.password !== draft.passwordConfirmation) return "The passwords do not match.";
  }
  return null;
}

export function SignupWizard({
  draft,
  step,
  preferences,
  resolvedAppearance,
  busy,
  canSubmit,
  availabilityMessage,
  serverError,
  onDraftChange,
  onStepChange,
  onPreferencesChange,
  onSubmit,
}: {
  draft: SignupDraft;
  step: SignupStep;
  preferences: TracePreferences;
  resolvedAppearance: ResolvedAppearance;
  busy: boolean;
  canSubmit: boolean;
  availabilityMessage: string | null;
  serverError: string | null;
  onDraftChange: (next: SignupDraft) => void;
  onStepChange: (next: SignupStep) => void;
  onPreferencesChange: (next: TracePreferences) => void;
  onSubmit: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const [attempted, setAttempted] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const localError = attempted ? validationMessage(step, draft) : null;
  const feedback = serverError ?? localError;
  const feedbackId = feedback ? "opening-signup-feedback" : undefined;
  const headingId = `opening-signup-title-${step}`;
  const passwordState = useMemo(() => ({
    enough: draft.password.length >= 12,
    matches: draft.password.length > 0 && draft.password === draft.passwordConfirmation,
  }), [draft.password, draft.passwordConfirmation]);

  useEffect(() => {
    setAttempted(false);
  }, [step]);

  const focusCurrentStep = () => {
    const target = step === 0
      ? nameRef.current
      : step === 1
        ? emailRef.current
        : step === 2
          ? passwordRef.current
          : headingRef.current;
    queueMicrotask(() => target?.focus());
  };

  const advance = () => {
    const error = validationMessage(step, draft);
    if (error) {
      setAttempted(true);
      return;
    }
    if (step === 3) {
      onSubmit();
      return;
    }
    onStepChange((step + 1) as SignupStep);
  };

  const changeDraft = (partial: Partial<SignupDraft>) => {
    onDraftChange({ ...draft, ...partial });
    if (attempted) setAttempted(false);
  };

  return (
    <form
      className="onboarding-opening-form onboarding-signup-form"
      aria-labelledby={headingId}
      aria-describedby={feedbackId}
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) advance();
      }}
    >
      <div className="onboarding-signup-progress" aria-label={`Step ${step + 1} of 4`}>
        <span>{step + 1} of 4</span>
        <ol aria-hidden="true">
          {stepCopy.map((_, index) => <li key={index} className={index <= step ? "is-current" : ""} />)}
        </ol>
      </div>

      <div className="onboarding-signup-step-stage">
        <AnimatePresence initial={false} mode="sync">
          <SignupStepView
            key={step}
            reducedMotion={Boolean(reducedMotion)}
            onEntered={focusCurrentStep}
          >
          <header className="onboarding-signup-heading">
            <h1 id={headingId} ref={headingRef} tabIndex={-1}>{stepCopy[step].title}</h1>
            <p>{stepCopy[step].detail}</p>
          </header>

          {step === 0 ? <>
            <label htmlFor="opening-signup-name">
              Name
              <input
                ref={nameRef}
                id="opening-signup-name"
                name="name"
                required
                maxLength={80}
                autoComplete="name"
                disabled={busy}
                value={draft.displayName}
                aria-invalid={Boolean(localError) || undefined}
                aria-describedby={feedbackId}
                onChange={(event) => changeDraft({ displayName: event.target.value })}
              />
            </label>
            <div className="onboarding-signup-name-preview" aria-live="polite">
              <span aria-hidden="true">{initials(draft.displayName)}</span>
              <p>{draft.displayName.trim() || "Your name"}<small>Teammates will see this name.</small></p>
            </div>
          </> : null}

          {step === 1 ? <label htmlFor="opening-signup-email">
            Email
            <input
              ref={emailRef}
              id="opening-signup-email"
              name="email"
              required
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              disabled={busy}
              value={draft.email}
              aria-invalid={Boolean(localError) || undefined}
              aria-describedby={feedbackId}
              onChange={(event) => changeDraft({ email: event.target.value })}
            />
          </label> : null}

          {step === 2 ? <>
            <label htmlFor="opening-signup-password">
              Password
              <span className="onboarding-signup-password-field">
                <input
                  ref={passwordRef}
                  id="opening-signup-password"
                  name="new-password"
                  required
                  type={showPassword ? "text" : "password"}
                  minLength={12}
                  maxLength={1024}
                  autoComplete="new-password"
                  disabled={busy}
                  value={draft.password}
                  aria-invalid={Boolean(localError) || undefined}
                  aria-describedby="opening-signup-password-status"
                  onChange={(event) => changeDraft({ password: event.target.value })}
                />
                <button
                  type="button"
                  disabled={busy}
                  aria-label={showPassword ? "Hide passwords" : "Show passwords"}
                  onClick={() => setShowPassword((visible) => !visible)}
                >
                  {showPassword ? "Hide" : "Show"}
                </button>
              </span>
            </label>
            <label htmlFor="opening-signup-password-confirmation">
              Confirm password
              <input
                id="opening-signup-password-confirmation"
                name="new-password-confirmation"
                required
                type={showPassword ? "text" : "password"}
                minLength={12}
                maxLength={1024}
                autoComplete="new-password"
                disabled={busy}
                value={draft.passwordConfirmation}
                aria-invalid={Boolean(localError) || undefined}
                aria-describedby="opening-signup-password-status"
                onChange={(event) => changeDraft({ passwordConfirmation: event.target.value })}
              />
            </label>
            <p id="opening-signup-password-status" className="onboarding-signup-password-status" aria-live="polite">
              <span className={passwordState.enough ? "is-ready" : ""}>{draft.password.length}/12 characters</span>
              {draft.passwordConfirmation ? <span className={passwordState.matches ? "is-ready" : "is-error"}>{passwordState.matches ? "Passwords match" : "Passwords differ"}</span> : null}
            </p>
          </> : null}

          {step === 3 ? <AppearanceControls
            className="appearance-controls--signup"
            value={preferences}
            resolvedAppearance={resolvedAppearance}
            disabled={busy}
            onChange={onPreferencesChange}
          /> : null}
          </SignupStepView>
        </AnimatePresence>
      </div>

      <div className="onboarding-signup-feedback-slot">
        {availabilityMessage ? <p className="onboarding-opening-feedback" role="status" aria-live="polite">{availabilityMessage}</p> : null}
        {feedback ? <p
          id="opening-signup-feedback"
          className="onboarding-opening-feedback onboarding-opening-feedback--error"
          role="alert"
        >
          {feedback}
        </p> : null}
      </div>

      <div className="onboarding-signup-navigation">
        {step > 0 ? <button
          type="button"
          className="onboarding-opening-link onboarding-signup-back"
          disabled={busy}
          onClick={() => onStepChange((step - 1) as SignupStep)}
        >
          ← Back
        </button> : <span />}
        <button
          type="submit"
          className="onboarding-opening-submit"
          disabled={busy || (step === 3 && !canSubmit)}
        >
          {busy ? "Creating account…" : step === 3 ? "Create account →" : "Next →"}
        </button>
      </div>
    </form>
  );
}
