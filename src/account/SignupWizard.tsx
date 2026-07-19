import {
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
} from "motion/react";
import { GradientAvatar } from "@outpacelabs/avatars";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type {
  Accent,
  Appearance,
  CodeSize,
  ResolvedAppearance,
  TracePreferences,
} from "../preferences/types";

export type SignupStep = 0 | 1 | 2 | 3;
export type SignupAvatarVariant =
  | 0 | 1 | 2 | 3 | 4 | 5
  | 6 | 7 | 8 | 9 | 10 | 11;

export type SignupDraft = {
  firstName: string;
  lastName: string;
  avatarVariant: SignupAvatarVariant;
  email: string;
  password: string;
  passwordConfirmation: string;
};

export const EMPTY_SIGNUP_DRAFT: SignupDraft = {
  firstName: "",
  lastName: "",
  avatarVariant: 0,
  email: "",
  password: "",
  passwordConfirmation: "",
};

const AVATAR_VARIANTS: readonly SignupAvatarVariant[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
];
const AVATAR_ITEM_PITCH_PX = 48;
const AVATAR_REBASE_THRESHOLD_PX = AVATAR_ITEM_PITCH_PX / 2;

export function signupDisplayName(draft: Pick<SignupDraft, "firstName" | "lastName">) {
  return [draft.firstName.trim(), draft.lastName.trim()].filter(Boolean).join(" ");
}

export function signupAvatarSeed(variant: SignupAvatarVariant) {
  return `trace-avatar:${variant}`;
}

export function clearSignupPasswordFields(draft: SignupDraft): SignupDraft {
  return {
    ...draft,
    password: "",
    passwordConfirmation: "",
  };
}

const stepCopy = [
  {
    title: "Set up your profile",
    detail: "Choose a name and generated avatar before continuing.",
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
    title: "Set up your editor",
    detail: "Pick a starting look. Every setting stays editable in Preferences.",
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
      transition={reducedMotion ? { duration: 0 } : { duration: 0.14, ease: "easeOut" }}
      onAnimationComplete={() => {
        if (isPresent) onEntered();
      }}
    >
      {children}
    </motion.div>
  );
}

function wrapAvatarIndex(index: number): SignupAvatarVariant {
  const count = AVATAR_VARIANTS.length;
  return ((index % count) + count) % count as SignupAvatarVariant;
}

function avatarVisualOrder(
  variant: SignupAvatarVariant,
  visualStart: SignupAvatarVariant,
) {
  return wrapAvatarIndex(variant - visualStart);
}

function SignupAvatarCarousel({
  value,
  disabled,
  reducedMotion,
  onChange,
}: {
  value: SignupAvatarVariant;
  disabled: boolean;
  reducedMotion: boolean;
  onChange: (variant: SignupAvatarVariant) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const [visualState, setVisualState] = useState(() => ({
    start: wrapAvatarIndex(value - Math.floor(AVATAR_VARIANTS.length / 2)),
    revision: 0,
  }));
  const visualStart = visualState.start;
  const [dragging, setDragging] = useState(false);
  const pendingOrderChangeRef = useRef<{
    steps: number;
    center?: { variant: SignupAvatarVariant; behavior: ScrollBehavior };
  } | null>(null);
  const rebasingRef = useRef(false);
  const rebaseFrameRef = useRef<number | null>(null);
  const clickFrameRef = useRef<number | null>(null);
  const pointerFocusTimeoutRef = useRef<number | null>(null);
  const programmaticScrollTimeoutRef = useRef<number | null>(null);
  const pointerFocusRef = useRef(false);
  const programmaticScrollRef = useRef(false);
  const suppressClickRef = useRef(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startScrollLeft: number;
    moved: boolean;
  } | null>(null);
  const centeredOnceRef = useRef(false);

  const scheduleFrame = (
    frameRef: { current: number | null },
    callback: () => void,
  ) => {
    if (frameRef.current !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(frameRef.current);
    }
    if (typeof requestAnimationFrame === "function") {
      frameRef.current = requestAnimationFrame(callback);
      return;
    }
    queueMicrotask(callback);
  };

  const centerAvatarNow = (
    variant: SignupAvatarVariant,
    behavior: ScrollBehavior,
  ) => {
    const viewport = viewportRef.current;
    const input = inputRefs.current[variant];
    const option = input?.closest<HTMLElement>(".onboarding-signup-avatar-option");
    if (!viewport || !option) return;
    const left = option.offsetLeft - ((viewport.clientWidth - option.offsetWidth) / 2);
    if (programmaticScrollTimeoutRef.current !== null) {
      window.clearTimeout(programmaticScrollTimeoutRef.current);
      programmaticScrollTimeoutRef.current = null;
    }
    programmaticScrollRef.current = behavior === "smooth";
    if (behavior === "smooth") {
      programmaticScrollTimeoutRef.current = window.setTimeout(() => {
        programmaticScrollRef.current = false;
        programmaticScrollTimeoutRef.current = null;
      }, 140);
    }
    if (typeof viewport.scrollTo === "function") {
      viewport.scrollTo({ left, behavior });
    } else {
      viewport.scrollLeft = left;
    }
  };

  const clearProgrammaticScroll = () => {
    const viewport = viewportRef.current;
    if (programmaticScrollRef.current && viewport && typeof viewport.scrollTo === "function") {
      viewport.scrollTo({ left: viewport.scrollLeft, behavior: "auto" });
    }
    programmaticScrollRef.current = false;
    if (programmaticScrollTimeoutRef.current !== null) {
      window.clearTimeout(programmaticScrollTimeoutRef.current);
      programmaticScrollTimeoutRef.current = null;
    }
  };

  const keepProgrammaticScrollGuard = () => {
    if (programmaticScrollTimeoutRef.current !== null) {
      window.clearTimeout(programmaticScrollTimeoutRef.current);
    }
    programmaticScrollTimeoutRef.current = window.setTimeout(() => {
      programmaticScrollRef.current = false;
      programmaticScrollTimeoutRef.current = null;
    }, 100);
  };

  const requestOrderChange = (
    steps: number,
    center?: { variant: SignupAvatarVariant; behavior: ScrollBehavior },
  ) => {
    const pending = pendingOrderChangeRef.current;
    pendingOrderChangeRef.current = pending
      ? {
          steps: pending.steps + steps,
          center: center ?? pending.center,
        }
      : { steps, center };
    rebasingRef.current = true;
    setVisualState((current) => ({
      start: wrapAvatarIndex(current.start + steps),
      revision: current.revision + 1,
    }));
  };

  const centerAvatar = (
    variant: SignupAvatarVariant,
    behavior: ScrollBehavior,
  ) => {
    const desiredOrder = Math.floor(AVATAR_VARIANTS.length / 2);
    const pendingSteps = pendingOrderChangeRef.current?.steps ?? 0;
    const effectiveStart = wrapAvatarIndex(visualStart + pendingSteps);
    const currentOrder = avatarVisualOrder(variant, effectiveStart);
    const steps = currentOrder - desiredOrder;
    if (steps === 0) {
      centerAvatarNow(variant, behavior);
      return;
    }
    requestOrderChange(steps, { variant, behavior });
  };

  useLayoutEffect(() => {
    const pending = pendingOrderChangeRef.current;
    const viewport = viewportRef.current;
    if (!pending || !viewport) return;
    const adjustment = -pending.steps * AVATAR_ITEM_PITCH_PX;
    viewport.scrollLeft += adjustment;
    if (dragRef.current) dragRef.current.startScrollLeft += adjustment;
    pendingOrderChangeRef.current = null;
    if (pending.center) {
      centerAvatarNow(pending.center.variant, pending.center.behavior);
    }
    scheduleFrame(rebaseFrameRef, () => {
      rebasingRef.current = false;
      rebaseFrameRef.current = null;
    });
  }, [visualState.revision]);

  useLayoutEffect(() => {
    const behavior = centeredOnceRef.current && !reducedMotion ? "smooth" : "auto";
    centerAvatar(value, behavior);
    centeredOnceRef.current = true;
  }, [reducedMotion, value]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      if (!dragRef.current && !rebasingRef.current) {
        centerAvatarNow(value, "auto");
      }
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [value]);

  useEffect(() => () => {
    if (typeof cancelAnimationFrame === "function") {
      for (const frameRef of [rebaseFrameRef, clickFrameRef]) {
        if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      }
    }
    if (pointerFocusTimeoutRef.current !== null) {
      window.clearTimeout(pointerFocusTimeoutRef.current);
    }
    if (programmaticScrollTimeoutRef.current !== null) {
      window.clearTimeout(programmaticScrollTimeoutRef.current);
    }
  }, []);

  const rebaseAtBoundary = () => {
    const viewport = viewportRef.current;
    if (programmaticScrollRef.current) {
      keepProgrammaticScrollGuard();
      return;
    }
    if (!viewport || rebasingRef.current) return;
    const maxScrollLeft = viewport.scrollWidth - viewport.clientWidth;
    if (maxScrollLeft < AVATAR_ITEM_PITCH_PX * 2) return;
    const direction = viewport.scrollLeft <= AVATAR_REBASE_THRESHOLD_PX
      ? "left"
      : viewport.scrollLeft >= maxScrollLeft - AVATAR_REBASE_THRESHOLD_PX
        ? "right"
        : null;
    if (!direction) return;
    const steps = direction === "right" ? 1 : -1;
    requestOrderChange(steps);
  };

  const beginPointerFocus = () => {
    clearProgrammaticScroll();
    pointerFocusRef.current = true;
    if (pointerFocusTimeoutRef.current !== null) {
      window.clearTimeout(pointerFocusTimeoutRef.current);
      pointerFocusTimeoutRef.current = null;
    }
  };

  const clearPointerFocusSoon = (delay = 0) => {
    if (pointerFocusTimeoutRef.current !== null) {
      window.clearTimeout(pointerFocusTimeoutRef.current);
    }
    pointerFocusTimeoutRef.current = window.setTimeout(() => {
      pointerFocusRef.current = false;
      pointerFocusTimeoutRef.current = null;
    }, delay);
  };

  const finishPointerDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    cancelled = false,
  ) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    dragRef.current = null;
    setDragging(false);
    if (!cancelled && drag.moved) {
      suppressClickRef.current = true;
      scheduleFrame(clickFrameRef, () => {
        suppressClickRef.current = false;
        clickFrameRef.current = null;
      });
    }
  };

  const handleAvatarKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement>,
    variant: SignupAvatarVariant,
  ) => {
    const direction = ["ArrowLeft", "ArrowUp"].includes(event.key)
      ? -1
      : ["ArrowRight", "ArrowDown"].includes(event.key)
        ? 1
        : 0;
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? 11
        : direction
          ? wrapAvatarIndex(variant + direction)
          : null;
    if (next === null) return;
    event.preventDefault();
    onChange(next as SignupAvatarVariant);
    queueMicrotask(() => {
      inputRefs.current[next]?.focus();
    });
  };

  return (
    <fieldset
      className="onboarding-signup-avatar-picker"
      aria-describedby="opening-signup-avatar-help"
    >
      <legend>Choose an avatar</legend>
      <p id="opening-signup-avatar-help" className="sr-only">
        Drag or scroll horizontally to browse. Use the arrow keys to change your selection.
      </p>
      <div className="onboarding-signup-avatar-carousel">
        <div
          ref={viewportRef}
          className="onboarding-signup-avatar-viewport"
          data-testid="signup-avatar-viewport"
          data-dragging={dragging ? "true" : "false"}
          onScroll={rebaseAtBoundary}
          onWheelCapture={clearProgrammaticScroll}
          onPointerDownCapture={beginPointerFocus}
          onPointerUpCapture={() => clearPointerFocusSoon(120)}
          onPointerDown={(event) => {
            if (disabled || event.button !== 0 || !["mouse", "pen"].includes(event.pointerType)) {
              return;
            }
            dragRef.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startScrollLeft: event.currentTarget.scrollLeft,
              moved: false,
            };
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            const distance = event.clientX - drag.startX;
            if (!drag.moved && Math.abs(distance) < 4) return;
            drag.moved = true;
            setDragging(true);
            event.preventDefault();
            event.currentTarget.scrollLeft = drag.startScrollLeft - distance;
          }}
          onPointerUp={(event) => finishPointerDrag(event)}
          onPointerCancel={(event) => {
            finishPointerDrag(event, true);
            pointerFocusRef.current = false;
            if (pointerFocusTimeoutRef.current !== null) {
              window.clearTimeout(pointerFocusTimeoutRef.current);
              pointerFocusTimeoutRef.current = null;
            }
          }}
          onLostPointerCapture={() => {
            dragRef.current = null;
            setDragging(false);
          }}
          onClickCapture={(event: ReactMouseEvent<HTMLDivElement>) => {
            clearPointerFocusSoon();
            if (!suppressClickRef.current) return;
            suppressClickRef.current = false;
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <div className="onboarding-signup-avatar-track">
            {AVATAR_VARIANTS.map((variant) => (
              <label
                key={variant}
                className={`onboarding-signup-avatar-option${value === variant ? " is-selected" : ""}`}
                style={{ order: avatarVisualOrder(variant, visualStart) }}
              >
                <input
                  ref={(node) => { inputRefs.current[variant] = node; }}
                  type="radio"
                  name="signup-avatar"
                  value={variant}
                  aria-label={`Avatar ${variant + 1}`}
                  checked={value === variant}
                  disabled={disabled}
                  onFocus={() => {
                    if (!pointerFocusRef.current) {
                      centerAvatar(variant, reducedMotion ? "auto" : "smooth");
                    }
                  }}
                  onKeyDown={(event) => handleAvatarKeyDown(event, variant)}
                  onChange={() => onChange(variant)}
                />
                <GradientAvatar seed={signupAvatarSeed(variant)} size={32} />
              </label>
            ))}
          </div>
        </div>
      </div>
    </fieldset>
  );
}

const signupAppearanceOptions: Array<{ value: Appearance; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const signupAccentOptions: Array<{ value: Accent; label: string }> = [
  { value: "cobalt", label: "Cobalt" },
  { value: "violet", label: "Violet" },
  { value: "teal", label: "Teal" },
  { value: "amber", label: "Amber" },
  { value: "rose", label: "Rose" },
];

const signupCodeSizeOptions: Array<{ value: CodeSize; label: string; mark: string }> = [
  { value: "small", label: "Small", mark: "A−" },
  { value: "default", label: "Default", mark: "A" },
  { value: "large", label: "Large", mark: "A+" },
];

function resolvedPreviewTheme(
  appearance: Appearance,
  resolvedAppearance: ResolvedAppearance,
) {
  return appearance === "system" ? resolvedAppearance : appearance;
}

function SignupAppearanceSetup({
  draft,
  value,
  resolvedAppearance,
  disabled,
  reducedMotion,
  onChange,
}: {
  draft: SignupDraft;
  value: TracePreferences;
  resolvedAppearance: ResolvedAppearance;
  disabled: boolean;
  reducedMotion: boolean;
  onChange: (next: TracePreferences) => void;
}) {
  const theme = resolvedPreviewTheme(value.appearance, resolvedAppearance);
  const previewKey = `${theme}-${value.accent}-${value.codeSize}`;
  const displayName = signupDisplayName(draft) || "Your workspace";
  const avatarSeed = signupAvatarSeed(draft.avatarVariant);
  const update = (partial: Partial<TracePreferences>) => {
    onChange({ ...value, ...partial });
  };

  return (
    <div className="onboarding-signup-appearance">
      <div className="onboarding-signup-workspace-preview" aria-label="Editor preview">
        <AnimatePresence initial={false} mode="sync">
          <motion.div
            key={previewKey}
            className={`onboarding-signup-workspace-preview__surface is-${theme} is-${value.codeSize} is-accent-${value.accent}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={reducedMotion ? { duration: 0 } : { duration: 0.16, ease: "easeOut" }}
            aria-hidden="true"
          >
            <div className="onboarding-signup-workspace-preview__topbar">
              <span className="onboarding-signup-workspace-preview__dots"><i /><i /><i /></span>
              <span>App.tsx</span>
              <span className="onboarding-signup-workspace-preview__identity">
                <GradientAvatar seed={avatarSeed} size={18} />
                {displayName}
              </span>
            </div>
            <div className="onboarding-signup-workspace-preview__code">
              <span><i>1</i><b>const</b> <em>workspace</em> = <strong>"trace"</strong>;</span>
              <span><i>2</i><b>return</b> <em>workspace</em>;</span>
              <span><i>3</i></span>
            </div>
          </motion.div>
        </AnimatePresence>
      </div>

      <fieldset className="onboarding-signup-setting onboarding-signup-setting--theme">
        <legend>Theme</legend>
        <div>
          {signupAppearanceOptions.map((option) => (
            <label key={option.value} className={value.appearance === option.value ? "is-selected" : ""}>
              <input
                type="radio"
                name="signup-appearance"
                value={option.value}
                checked={value.appearance === option.value}
                disabled={disabled}
                onChange={() => update({ appearance: option.value })}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="onboarding-signup-setting-row">
        <fieldset className="onboarding-signup-setting onboarding-signup-setting--accent">
          <legend>Accent</legend>
          <div>
            {signupAccentOptions.map((option) => (
              <label
                key={option.value}
                className={`is-${option.value}${value.accent === option.value ? " is-selected" : ""}`}
                title={option.label}
              >
                <input
                  type="radio"
                  name="signup-accent"
                  value={option.value}
                  checked={value.accent === option.value}
                  disabled={disabled}
                  onChange={() => update({ accent: option.value })}
                />
                <span aria-hidden="true" />
                <span className="sr-only">{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="onboarding-signup-setting onboarding-signup-setting--size">
          <legend>Type size</legend>
          <div>
            {signupCodeSizeOptions.map((option) => (
              <label key={option.value} className={value.codeSize === option.value ? "is-selected" : ""}>
                <input
                  type="radio"
                  name="signup-code-size"
                  value={option.value}
                  checked={value.codeSize === option.value}
                  disabled={disabled}
                  onChange={() => update({ codeSize: option.value })}
                />
                <span aria-hidden="true">{option.mark}</span>
                <span className="sr-only">{option.label} code</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>
    </div>
  );
}

type SignupValidationField =
  | "firstName"
  | "lastName"
  | "email"
  | "password"
  | "passwordConfirmation";

type SignupValidationIssue = {
  field: SignupValidationField;
  message: string;
};

function validationIssue(step: SignupStep, draft: SignupDraft): SignupValidationIssue | null {
  if (step === 0) {
    if (!draft.firstName.trim()) {
      return { field: "firstName", message: "Enter your first name." };
    }
    if (!draft.lastName.trim()) {
      return { field: "lastName", message: "Enter your last name." };
    }
    if (signupDisplayName(draft).length > 80) {
      return {
        field: "lastName",
        message: "Your full name must be 80 characters or fewer.",
      };
    }
    return null;
  }
  if (step === 1) {
    if (!draft.email.trim()) {
      return { field: "email", message: "Enter your email address." };
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(draft.email.trim())) {
      return { field: "email", message: "Enter a valid email address." };
    }
    return null;
  }
  if (step === 2) {
    if (draft.password.length < 12) {
      return {
        field: "password",
        message: "Your password must be at least 12 characters.",
      };
    }
    if (draft.password !== draft.passwordConfirmation) {
      return {
        field: "passwordConfirmation",
        message: "The passwords do not match.",
      };
    }
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
  const firstNameRef = useRef<HTMLInputElement>(null);
  const lastNameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const passwordConfirmationRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const localIssue = attempted ? validationIssue(step, draft) : null;
  const feedback = serverError ?? localIssue?.message ?? null;
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
      ? firstNameRef.current
      : step === 1
        ? emailRef.current
        : step === 2
          ? passwordRef.current
          : headingRef.current;
    queueMicrotask(() => target?.focus());
  };

  const advance = () => {
    const issue = validationIssue(step, draft);
    if (issue) {
      setAttempted(true);
      const invalidTarget = {
        firstName: firstNameRef,
        lastName: lastNameRef,
        email: emailRef,
        password: passwordRef,
        passwordConfirmation: passwordConfirmationRef,
      }[issue.field];
      queueMicrotask(() => invalidTarget.current?.focus());
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
      noValidate
      aria-labelledby={headingId}
      aria-describedby={feedbackId}
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) advance();
      }}
    >
      <div
        className="onboarding-signup-progress"
        role="progressbar"
        aria-label={`Step ${step + 1} of 4`}
        aria-valuemin={1}
        aria-valuemax={4}
        aria-valuenow={step + 1}
      >
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
            <div className="onboarding-signup-name-fields">
              <label htmlFor="opening-signup-first-name">
                First name
                <input
                  ref={firstNameRef}
                  id="opening-signup-first-name"
                  name="given-name"
                  required
                  maxLength={80}
                  autoComplete="given-name"
                  disabled={busy}
                  value={draft.firstName}
                  aria-invalid={localIssue?.field === "firstName" || undefined}
                  aria-describedby={localIssue?.field === "firstName" ? feedbackId : undefined}
                  onChange={(event) => changeDraft({ firstName: event.target.value })}
                />
              </label>
              <label htmlFor="opening-signup-last-name">
                Last name
                <input
                  ref={lastNameRef}
                  id="opening-signup-last-name"
                  name="family-name"
                  required
                  maxLength={80}
                  autoComplete="family-name"
                  disabled={busy}
                  value={draft.lastName}
                  aria-invalid={localIssue?.field === "lastName" || undefined}
                  aria-describedby={localIssue?.field === "lastName" ? feedbackId : undefined}
                  onChange={(event) => changeDraft({ lastName: event.target.value })}
                />
              </label>
            </div>

            <div className="onboarding-signup-profile-preview">
              <div className="onboarding-signup-avatar-preview-stage" aria-hidden="true">
                <AnimatePresence initial={false} mode="sync">
                  <motion.div
                    key={signupAvatarSeed(draft.avatarVariant)}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={reducedMotion ? { duration: 0 } : { duration: 0.16, ease: "easeOut" }}
                  >
                    <GradientAvatar
                      seed={signupAvatarSeed(draft.avatarVariant)}
                      size={46}
                    />
                  </motion.div>
                </AnimatePresence>
              </div>
              <p>
                <small>Profile preview</small>
                <strong>{signupDisplayName(draft) || "Your name"}</strong>
                <span>Updates when you choose an avatar</span>
              </p>
            </div>

            <SignupAvatarCarousel
              value={draft.avatarVariant}
              disabled={busy}
              reducedMotion={Boolean(reducedMotion)}
              onChange={(avatarVariant) => changeDraft({ avatarVariant })}
            />
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
              aria-invalid={localIssue?.field === "email" || undefined}
              aria-describedby={localIssue?.field === "email" ? feedbackId : undefined}
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
                  aria-invalid={localIssue?.field === "password" || undefined}
                  aria-describedby={`opening-signup-password-status${localIssue?.field === "password" && feedbackId ? ` ${feedbackId}` : ""}`}
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
                ref={passwordConfirmationRef}
                id="opening-signup-password-confirmation"
                name="new-password-confirmation"
                required
                type={showPassword ? "text" : "password"}
                minLength={12}
                maxLength={1024}
                autoComplete="new-password"
                disabled={busy}
                value={draft.passwordConfirmation}
                aria-invalid={localIssue?.field === "passwordConfirmation" || undefined}
                aria-describedby={`opening-signup-password-status${localIssue?.field === "passwordConfirmation" && feedbackId ? ` ${feedbackId}` : ""}`}
                onChange={(event) => changeDraft({ passwordConfirmation: event.target.value })}
              />
            </label>
            <p id="opening-signup-password-status" className="onboarding-signup-password-status" aria-live="polite">
              <span className={passwordState.enough ? "is-ready" : ""}>{draft.password.length}/12 characters</span>
              {draft.passwordConfirmation ? <span className={passwordState.matches ? "is-ready" : "is-error"}>{passwordState.matches ? "Passwords match" : "Passwords differ"}</span> : null}
            </p>
          </> : null}

          {step === 3 ? <SignupAppearanceSetup
            draft={draft}
            value={preferences}
            resolvedAppearance={resolvedAppearance}
            disabled={busy}
            reducedMotion={Boolean(reducedMotion)}
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
