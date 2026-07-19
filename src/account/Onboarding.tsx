import {
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
} from "motion/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { ArrowLeft, Check, ChevronLeft, FolderOpen, GitFork } from "lucide-react";
import { traceAccountApi, TraceAccountError } from "./api";
import {
  canUpdateOpeningPointer,
  OpeningArrowBackground,
  type OpeningArrowBackgroundHandle,
  type OpeningReadingField,
} from "./OpeningArrowBackground";
import type { CloudRepository, GitHubAppInstallation, TraceAccount } from "./types";
import {
  afterVerificationRefresh,
  nextForAccount,
  type OnboardingIntent,
  type OnboardingScreen,
} from "./onboarding-state";
import {
  EMPTY_SIGNUP_DRAFT,
  SignupWizard,
  clearSignupPasswordFields,
  signupDisplayName,
  type SignupDraft,
  type SignupStep,
} from "./SignupWizard";
import {
  DEFAULT_PREFERENCES,
  type ResolvedAppearance,
  type TracePreferences,
} from "../preferences/types";
import {
  OPENING_CHOICE_EXIT_DURATION_MS,
  OPENING_CONTENT_EASE,
  OPENING_FORM_ENTRY_DELAY_MS,
  OPENING_FORM_ENTRY_DURATION_MS,
  OPENING_SCENE_DURATION_MS,
} from "./opening-motion";
import traceFrameUrl from "../../design/trace-frame.svg?url";

type Screen = OnboardingScreen | "reset-request" | "reset-confirm" | "repository" | "workspace" | "invite" | "complete";
type Intent = OnboardingIntent;
type OpeningScreen = Extract<Screen, "choice" | "sign-in" | "sign-up" | "verify">;

function isOpeningScreen(screen: Screen): screen is OpeningScreen {
  return screen === "choice" || screen === "sign-in" || screen === "sign-up" || screen === "verify";
}

function openingReadingFieldFor(screen: Screen): OpeningReadingField {
  if (screen === "sign-up" || screen === "verify") return "expanded";
  if (screen === "sign-in") return "compact";
  return "none";
}

function openingStageTransition(
  reducedMotion: boolean | null,
  enteredFromChoice: boolean,
  isPresent: boolean,
) {
  if (reducedMotion) return { duration: 0 };
  if (!isPresent) {
    return {
      duration: OPENING_CHOICE_EXIT_DURATION_MS / 1000,
      ease: OPENING_CONTENT_EASE,
    };
  }
  if (enteredFromChoice) {
    return {
      delay: OPENING_FORM_ENTRY_DELAY_MS / 1000,
      duration: OPENING_FORM_ENTRY_DURATION_MS / 1000,
      ease: OPENING_CONTENT_EASE,
    };
  }
  return { duration: 0.14, ease: OPENING_CONTENT_EASE };
}

function OpeningFormStage({
  children,
  onEntered,
  enteredFromChoice,
}: {
  children: ReactNode;
  onEntered: () => void;
  enteredFromChoice: boolean;
}) {
  const isPresent = useIsPresent();
  const reducedMotion = useReducedMotion();

  return (
    <motion.div
      className="onboarding-opening-form-stage"
      data-present={isPresent ? "true" : "false"}
      inert={isPresent ? undefined : true}
      aria-hidden={isPresent ? undefined : true}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={openingStageTransition(reducedMotion, enteredFromChoice, isPresent)}
      onAnimationComplete={() => {
        if (isPresent) onEntered();
      }}
    >
      {children}
    </motion.div>
  );
}

function errorText(error: unknown): string {
  if (error instanceof TraceAccountError) return error.message;
  return "Trace could not complete that request. Try again.";
}

const setupSteps = [
  { id: "account", label: "Account" },
  { id: "github", label: "GitHub" },
  { id: "workspace", label: "Workspace" },
] as const;

type SetupStep = (typeof setupSteps)[number]["id"];

function activeStepFor(screen: Screen): SetupStep {
  if (screen === "github" || screen === "installation" || screen === "repository") return "github";
  if (screen === "workspace" || screen === "invite" || screen === "redeem" || screen === "complete") return "workspace";
  return "account";
}

function screenDetails(screen: Screen) {
  if (screen === "choice") return {
    section: "Setup",
    title: "Set up Trace",
    copy: "Use an account for shared workspaces, or open a folder that stays on this Mac.",
  };
  if (screen === "sign-up") return {
    section: "Account",
    title: "Create an account",
    copy: "Use the name and email address your teammates know.",
  };
  if (screen === "sign-in") return {
    section: "Account",
    title: "Sign in to Trace",
    copy: "Open your shared workspaces on this Mac.",
  };
  if (screen === "verify") return {
    section: "Account",
    title: "Check your email",
    copy: "Open the verification link we sent, then return to Trace.",
  };
  if (screen === "reset-request" || screen === "reset-confirm") return {
    section: "Account",
    title: "Reset your password",
    copy: screen === "reset-request" ? "Enter your account email. We’ll send a reset link." : "Enter a new password for your Trace account.",
  };
  if (screen === "github") return {
    section: "GitHub",
    title: "Connect GitHub",
    copy: "Link the GitHub account that can access your team repository.",
  };
  if (screen === "installation") return {
    section: "GitHub",
    title: "Choose an installation",
    copy: "Select the account or organization where Trace is installed.",
  };
  if (screen === "repository") return {
    section: "GitHub",
    title: "Choose a repository",
    copy: "This repository will back the Trace workspace.",
  };
  if (screen === "workspace") return {
    section: "Workspace",
    title: "Name the workspace",
    copy: "Choose the name your team will see in Trace.",
  };
  if (screen === "invite") return {
    section: "Workspace",
    title: "Invite a teammate",
    copy: "Send a one-time invitation. It expires in seven days.",
  };
  if (screen === "redeem") return {
    section: "Workspace",
    title: "Join a workspace",
    copy: "Use the invitation you received to join the workspace.",
  };
  return {
    section: "Ready",
    title: "Setup complete",
    copy: "Your workspace is ready. Open a local folder to start working.",
  };
}

export function Onboarding({
  onContinueLocal,
  preferences = DEFAULT_PREFERENCES,
  resolvedAppearance = "light",
  onPreferencesChange = () => undefined,
}: {
  onContinueLocal: () => void;
  preferences?: TracePreferences;
  resolvedAppearance?: ResolvedAppearance;
  onPreferencesChange?: (next: TracePreferences) => void;
}) {
  const api = traceAccountApi;
  const [screen, setScreen] = useState<Screen>("choice");
  const [intent, setIntent] = useState<Intent>("owner");
  const [account, setAccount] = useState<TraceAccount | null>(null);
  const [availability, setAvailability] = useState<"loading" | "ready" | "not-configured">(api ? "loading" : "not-configured");
  const [message, setMessage] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signupDraft, setSignupDraft] = useState<SignupDraft>(() => ({ ...EMPTY_SIGNUP_DRAFT }));
  const [signupStep, setSignupStep] = useState<SignupStep>(0);
  const [signupError, setSignupError] = useState<string | null>(null);
  const [signupPreferences, setSignupPreferences] = useState<TracePreferences>(preferences);
  const [resetToken, setResetToken] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [installations, setInstallations] = useState<GitHubAppInstallation[]>([]);
  const [selectedInstallation, setSelectedInstallation] = useState<string>("");
  const [repositories, setRepositories] = useState<CloudRepository[]>([]);
  const [selectedRepository, setSelectedRepository] = useState<CloudRepository | null>(null);
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspace, setWorkspace] = useState<{ id: string; name: string } | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [pendingInvite, setPendingInvite] = useState(false);
  const [pendingPasswordReset, setPendingPasswordReset] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const openingArrowRef = useRef<OpeningArrowBackgroundHandle>(null);
  const loginButtonRef = useRef<HTMLButtonElement>(null);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const passwordInputRef = useRef<HTMLInputElement>(null);
  const verifyHeadingRef = useRef<HTMLHeadingElement>(null);
  const restoreChoiceFocusRef = useRef(false);
  const openingTransitionRef = useRef<{
    source: OpeningScreen;
    target: OpeningScreen;
  }>({ source: "choice", target: "choice" });
  const signInPendingRef = useRef(false);
  const signUpPendingRef = useRef(false);

  const cloudReady = availability === "ready" && Boolean(api);
  const details = useMemo(() => screenDetails(screen), [screen]);
  const activeStep = activeStepFor(screen);
  const isOpeningCanvas = isOpeningScreen(screen);
  const openingReadingField = openingReadingFieldFor(screen);
  const reducedOpeningMotion = useReducedMotion();
  if (isOpeningCanvas && openingTransitionRef.current.target !== screen) {
    openingTransitionRef.current = {
      source: openingTransitionRef.current.target,
      target: screen,
    };
  }
  const enteredOpeningFormFromChoice = isOpeningCanvas
    && screen !== "choice"
    && openingTransitionRef.current.source === "choice";
  const enteredOpeningChoiceFromForm = screen === "choice"
    && openingTransitionRef.current.source !== "choice";
  const openingChoiceTransition = reducedOpeningMotion
    ? { duration: 0 }
    : screen === "choice"
      ? enteredOpeningChoiceFromForm
        ? {
          delay: OPENING_FORM_ENTRY_DELAY_MS / 1000,
          duration: OPENING_FORM_ENTRY_DURATION_MS / 1000,
          ease: OPENING_CONTENT_EASE,
        }
        : { duration: 0 }
      : {
        duration: OPENING_CHOICE_EXIT_DURATION_MS / 1000,
        ease: OPENING_CONTENT_EASE,
      };
  const openingBackTransition = reducedOpeningMotion
    ? { duration: 0 }
    : screen === "choice"
      ? {
        duration: OPENING_CHOICE_EXIT_DURATION_MS / 1000,
        ease: OPENING_CONTENT_EASE,
      }
      : enteredOpeningFormFromChoice
        ? {
          delay: OPENING_FORM_ENTRY_DELAY_MS / 1000,
          duration: OPENING_FORM_ENTRY_DURATION_MS / 1000,
          ease: OPENING_CONTENT_EASE,
        }
        : { duration: 0.14, ease: OPENING_CONTENT_EASE };
  const openingStatusMessage = availability === "loading"
    ? "Checking the Trace account service…"
    : availability === "not-configured"
      ? message ?? "Trace accounts are not configured on this Mac."
      : message;
  const signupAvailabilityMessage = availability === "ready" ? null : openingStatusMessage;
  const loginDescriptionIds = [
    openingStatusMessage ? "opening-login-status" : null,
    loginError ? "opening-login-error" : null,
  ].filter(Boolean).join(" ") || undefined;

  useEffect(() => {
    if (!isOpeningCanvas) headingRef.current?.focus();
  }, [isOpeningCanvas, screen]);

  useEffect(() => {
    setSignupPreferences(preferences);
  }, [preferences]);

  useEffect(() => {
    if (!api) return;
    void Promise.all([api.state(), api.pendingInvite(), api.pendingPasswordReset()]).then(([state, pending, reset]) => {
      setAvailability(state.availability);
      setAccount(state.user);
      setPendingInvite(pending.pending);
      setPendingPasswordReset(reset.pending);
      if (reset.pending) {
        setScreen("reset-confirm");
        setMessage("Choose a new password for your Trace account.");
      } else if (pending.pending) {
        setIntent("invitee");
        setScreen(state.user ? "redeem" : "sign-in");
        setLoginError(null);
        setMessage("A Trace invitation is ready. Sign in to join it.");
      } else {
        setMessage(state.message);
      }
    }).catch((error) => { setAvailability("not-configured"); setMessage(errorText(error)); });
  }, [api]);

  useEffect(() => {
    if (!api) return;
    return api.onDeepLink((event) => {
      if (event.kind === "invite") {
        setPendingInvite(true);
        setIntent("invitee");
        setScreen(account ? "redeem" : "sign-in");
        setLoginError(null);
        setMessage("A Trace invitation is ready. Sign in to join it.");
      }
      if (event.kind === "password-reset") {
        setPendingPasswordReset(true);
        setScreen("reset-confirm");
        setMessage("Choose a new password for your Trace account.");
      }
    });
  }, [api, account]);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try { await operation(); }
    catch (error) { setMessage(errorText(error)); }
    finally { setBusy(false); }
  };

  const refreshAccount = async () => {
    if (!api) return;
    const result = await api.refreshState();
    if (!result.user) {
      setScreen(afterVerificationRefresh(result.user, intent));
      setMessage("Email verification is complete. Sign in to continue.");
      return;
    }
    setScreen(afterVerificationRefresh(result.user, intent));
    setAccount(result.user);
  };

  const loadInstallations = async () => {
    if (!api) return;
    const next = await api.listInstallations();
    setInstallations(next);
    if (next.length === 1) setSelectedInstallation(next[0]?.id ?? "");
  };

  useEffect(() => {
    if (screen === "installation" && cloudReady) void run(loadInstallations);
  // Loading is only tied to entering this screen, not changing the callback identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, cloudReady]);

  const loadRepositories = async (installationId: string) => {
    if (!api) return;
    const next = await api.listRepositories(installationId);
    setRepositories(next);
    setSelectedRepository(next[0] ?? null);
    setScreen("repository");
  };

  const focusOpeningView = useCallback((openingScreen: OpeningScreen) => {
    if (openingScreen === "choice") {
      if (restoreChoiceFocusRef.current) loginButtonRef.current?.focus();
      restoreChoiceFocusRef.current = false;
      return;
    }
    if (openingScreen === "sign-in") {
      const target = emailInputRef.current?.value
        ? passwordInputRef.current
        : emailInputRef.current;
      target?.focus();
      return;
    }
    if (openingScreen === "verify") verifyHeadingRef.current?.focus();
  }, []);

  const returnToStart = () => {
    setIntent("owner");
    setMessage(null);
    setLoginError(null);
    setPassword("");
    restoreChoiceFocusRef.current = true;
    openingArrowRef.current?.clearPointer();
    setScreen("choice");
  };

  const beginOpeningScreen = (nextScreen: "sign-in" | "sign-up") => {
    setIntent("owner");
    setMessage(null);
    setLoginError(null);
    if (nextScreen === "sign-up") setSignupError(null);
    openingArrowRef.current?.clearPointer();
    setScreen(nextScreen);
  };

  const returnToOpeningChoice = useCallback(() => {
    // The refs are set synchronously at the start of an account request. They
    // close the small window before React has committed `busy`, where Escape
    // or the top-left Back control could otherwise abandon a pending request.
    if (busy || signInPendingRef.current || signUpPendingRef.current) return;
    setIntent("owner");
    setMessage(null);
    setLoginError(null);
    setPassword("");
    setSignupDraft(clearSignupPasswordFields);
    setSignupError(null);
    setSignupStep(0);
    restoreChoiceFocusRef.current = true;
    openingArrowRef.current?.clearPointer();
    setScreen("choice");
  }, [busy]);

  const submitSignIn = async () => {
    if (!api || !cloudReady || signInPendingRef.current) return;
    signInPendingRef.current = true;
    setBusy(true);
    setLoginError(null);
    try {
      const result = await api.signIn({ email, password });
      setAccount(result.user);
      setPassword("");
      setMessage(null);
      setScreen(nextForAccount(result.user, intent));
    } catch (error) {
      setLoginError(errorText(error));
    } finally {
      signInPendingRef.current = false;
      setBusy(false);
    }
  };

  const submitSignUp = async () => {
    if (!api || !cloudReady || signUpPendingRef.current) return;
    signUpPendingRef.current = true;
    setBusy(true);
    setSignupError(null);
    try {
      const displayName = signupDisplayName(signupDraft);
      const signUpEmail = signupDraft.email.trim();
      await api.signUp({
        displayName,
        email: signUpEmail,
        password: signupDraft.password,
      });
      setEmail(signUpEmail);
      setSignupDraft((draft) => ({
        ...clearSignupPasswordFields(draft),
        firstName: draft.firstName.trim(),
        lastName: draft.lastName.trim(),
        email: signUpEmail,
      }));
      setMessage(null);
      setScreen("verify");
    } catch (error) {
      setSignupError(errorText(error));
    } finally {
      signUpPendingRef.current = false;
      setBusy(false);
    }
  };

  const updateSignupPreferences = (next: TracePreferences) => {
    setSignupPreferences(next);
    onPreferencesChange(next);
  };

  const returnToSignIn = () => {
    if (busy) return;
    setMessage(null);
    setLoginError(null);
    setPassword("");
    openingArrowRef.current?.clearPointer();
    setScreen("sign-in");
  };

  const beginPasswordReset = () => {
    if (busy) return;
    setPassword("");
    setLoginError(null);
    setMessage(null);
    setScreen("reset-request");
  };

  useEffect(() => {
    if (screen === "choice") return;
    openingArrowRef.current?.clearPointer();
  }, [screen]);

  useEffect(() => {
    if (screen !== "sign-in" && screen !== "sign-up") return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape"
        || busy
        || signInPendingRef.current
        || signUpPendingRef.current
      ) return;
      returnToOpeningChoice();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, returnToOpeningChoice, screen]);

  const handleOpeningPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === "pen" && event.pressure > 0) {
      openingArrowRef.current?.clearPointer();
      return;
    }
    if (!canUpdateOpeningPointer(
      screen === "choice",
      event.pointerType,
      event.pressure,
    )) return;
    openingArrowRef.current?.updatePointer({
      x: event.clientX,
      y: event.clientY,
    });
  };

  const handleOpeningPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === "pen" && event.pressure > 0) {
      openingArrowRef.current?.clearPointer();
    }
  };

  return (
    <section
      className={`onboarding${isOpeningCanvas ? " onboarding--opening" : ""}`}
      data-onboarding-screen={screen}
      aria-label={screen === "choice" ? "Trace account access" : undefined}
      aria-labelledby={screen === "sign-in"
        ? "opening-sign-in-title"
        : screen === "sign-up"
          ? "opening-signup-title"
          : screen === "verify"
            ? "opening-verify-title"
          : isOpeningCanvas
            ? undefined
            : "onboarding-title"}
      onPointerMove={screen === "choice" ? handleOpeningPointerMove : undefined}
      onPointerDown={screen === "choice" ? handleOpeningPointerDown : undefined}
      onPointerLeave={screen === "choice"
        ? () => openingArrowRef.current?.clearPointer()
        : undefined}
    >
      {isOpeningCanvas ? <OpeningArrowBackground
        ref={openingArrowRef}
        readingField={openingReadingField}
      /> : null}
      {isOpeningScreen(screen) ? <div
        className="onboarding-opening-scene"
        style={{ "--opening-scene-duration": `${OPENING_SCENE_DURATION_MS}ms` } as CSSProperties}
      >
        <motion.div
          className="onboarding-opening-choice-stage"
          data-active={screen === "choice" ? "true" : "false"}
          inert={screen === "choice" ? undefined : true}
          aria-hidden={screen === "choice" ? undefined : true}
          initial={false}
          animate={{ opacity: screen === "choice" ? 1 : 0 }}
          transition={openingChoiceTransition}
          onAnimationComplete={() => {
            if (screen === "choice") focusOpeningView("choice");
          }}
        >
          <div className="onboarding-opening-lockup">
            <img
              className="onboarding-opening-lockup__mark"
              src={traceFrameUrl}
              alt=""
              aria-hidden="true"
              width="25"
              height="25"
              draggable={false}
            />
            <span>Trace</span>
          </div>
          <div
            className="onboarding-opening-actions"
            role="group"
            aria-label="Account access"
          >
            <button
              ref={loginButtonRef}
              type="button"
              className="onboarding-opening-action"
              onClick={() => beginOpeningScreen("sign-in")}
            >
              Login
            </button>
            <button
              type="button"
              className="onboarding-opening-action onboarding-opening-action--primary"
              onClick={() => beginOpeningScreen("sign-up")}
            >
              Sign up
            </button>
          </div>
        </motion.div>

        <motion.div
          className="onboarding-opening-back-stage"
          data-active={screen === "choice" ? "false" : "true"}
          inert={screen === "choice" ? true : undefined}
          aria-hidden={screen === "choice" ? true : undefined}
          initial={false}
          animate={{ opacity: screen === "choice" ? 0 : 1 }}
          transition={openingBackTransition}
        >
          <button
            type="button"
            className="onboarding-opening-back"
            disabled={busy || screen === "choice"}
            tabIndex={screen === "choice" ? -1 : undefined}
            onClick={screen === "verify" ? returnToSignIn : returnToOpeningChoice}
          >
            <ArrowLeft aria-hidden="true" />
            <span>Back</span>
          </button>
        </motion.div>

        <AnimatePresence initial={false} mode="sync">
          {screen !== "choice" ? <OpeningFormStage
            key={screen}
            enteredFromChoice={enteredOpeningFormFromChoice}
            onEntered={() => focusOpeningView(screen)}
          >
          {screen === "sign-in" ? <form
            className="onboarding-opening-form"
            aria-labelledby="opening-sign-in-title"
            aria-describedby={loginDescriptionIds}
            aria-busy={busy}
            onSubmit={(event) => {
              event.preventDefault();
              void submitSignIn();
            }}
          >
            <h1 id="opening-sign-in-title">Sign in to Trace</h1>
            <label htmlFor="opening-login-email">
              Email
              <input
                ref={emailInputRef}
                id="opening-login-email"
                name="email"
                required
                type="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                disabled={busy}
                value={email}
                aria-describedby={loginDescriptionIds}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setLoginError(null);
                }}
              />
            </label>
            <label htmlFor="opening-login-password">
              Password
              <input
                ref={passwordInputRef}
                id="opening-login-password"
                name="password"
                required
                type="password"
                autoComplete="current-password"
                disabled={busy}
                value={password}
                aria-describedby={loginDescriptionIds}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setLoginError(null);
                }}
              />
            </label>
            {openingStatusMessage ? <p
              id="opening-login-status"
              className="onboarding-opening-feedback"
              role="status"
              aria-live="polite"
            >
              {openingStatusMessage}
            </p> : null}
            {loginError ? <p
              id="opening-login-error"
              className="onboarding-opening-feedback onboarding-opening-feedback--error"
              role="alert"
            >
              {loginError}
            </p> : null}
            <button
              type="submit"
              className="onboarding-opening-submit"
              disabled={busy || !cloudReady}
            >
              {busy ? "Signing in…" : "Login"}
            </button>
            <button
              type="button"
              className="onboarding-opening-link"
              disabled={busy}
              onClick={beginPasswordReset}
            >
              Forgot password?
            </button>
          </form> : null}

          {screen === "sign-up" ? <SignupWizard
            draft={signupDraft}
            step={signupStep}
            preferences={signupPreferences}
            resolvedAppearance={resolvedAppearance}
            busy={busy}
            canSubmit={cloudReady}
            availabilityMessage={signupAvailabilityMessage}
            // A preference-save failure belongs to the shared Preferences
            // surface, not the account request. Keeping this channel limited
            // to signup errors lets a global signup exit genuinely clear its
            // feedback before the user starts again.
            serverError={signupError}
            onDraftChange={(next) => {
              setSignupDraft(next);
              setSignupError(null);
            }}
            onStepChange={(next) => {
              setSignupStep(next);
              setSignupError(null);
            }}
            onPreferencesChange={updateSignupPreferences}
            onSubmit={() => void submitSignUp()}
          /> : null}

          {screen === "verify" ? <div
            className="onboarding-opening-form onboarding-opening-verify"
            aria-labelledby="opening-verify-title"
            aria-busy={busy}
          >
            <h1 id="opening-verify-title" ref={verifyHeadingRef} tabIndex={-1}>Check your email</h1>
            <p className="onboarding-opening-verify-copy">
              Check <strong>{email || "your inbox"}</strong> for a verification link. Once it opens in your browser, return here.
            </p>
            {openingStatusMessage ? <p className="onboarding-opening-feedback" role="status" aria-live="polite">
              {openingStatusMessage}
            </p> : null}
            <button
              type="button"
              className="onboarding-opening-submit"
              disabled={busy || !api}
              onClick={() => void run(refreshAccount)}
            >
              {busy ? "Checking…" : "I verified my email"}
            </button>
            <div className="onboarding-opening-verify-actions">
              <button
                type="button"
                className="onboarding-opening-link"
                disabled={busy || !api || !email}
                onClick={() => void run(async () => {
                  if (!api) return;
                  await api.resendVerification({ email });
                  setMessage("A new verification email is on its way.");
                })}
              >
                Resend verification email
              </button>
              <button type="button" className="onboarding-opening-link" disabled={busy} onClick={returnToSignIn}>
                Back to sign in
              </button>
            </div>
          </div> : null}
          </OpeningFormStage> : null}
        </AnimatePresence>
      </div> : null}
      {!isOpeningCanvas ? <motion.div className="onboarding-shell" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.14, ease: "easeOut" }}>
        <aside className="onboarding-rail" aria-label="Setup progress">
          <div className="onboarding-brand">
            <span className="trace-mark" aria-hidden="true"><i /><i /><i /></span>
            <strong>Trace</strong>
          </div>
          <p className="onboarding-rail-label">Setup</p>

          <ol className="onboarding-progress">
            {setupSteps.map((step) => {
              const active = step.id === activeStep;
              const complete = step.id === "account"
                ? activeStep !== "account" || Boolean(account?.emailVerified)
                : step.id === "github"
                  ? Boolean(account?.githubLinked)
                  : screen === "complete";
              return (
                <li key={step.id} className={`onboarding-progress-step${active ? " is-active" : ""}${complete ? " is-complete" : ""}`} aria-current={active ? "step" : undefined}>
                  <span className="onboarding-progress-marker">
                    {complete ? <Check aria-hidden="true" /> : <i aria-hidden="true" />}
                  </span>
                  <span>{step.label}</span>
                </li>
              );
            })}
          </ol>

          <div className="onboarding-rail-footer">
            <FolderOpen aria-hidden="true" />
            <p>Files stay on this Mac unless you connect them.</p>
          </div>
        </aside>

        <main className="onboarding-content">
          <div className="onboarding-topline">
            <span>{details.section}</span>
            <button type="button" className="onboarding-back" onClick={returnToStart}><ChevronLeft aria-hidden="true" />Back to setup</button>
          </div>
          <div className="onboarding-document">
            <header className="onboarding-heading">
              <h1 id="onboarding-title" ref={headingRef} tabIndex={-1}>{details.title}</h1>
              <p>{details.copy}</p>
            </header>
            {message ? <p className="onboarding-feedback" role="status" aria-live="polite">{message}</p> : null}

            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={screen} className="onboarding-body" aria-busy={busy} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12, ease: "easeOut" }}>
            {screen === "reset-request" ? <form onSubmit={(event) => { event.preventDefault(); void run(async () => { if (!api) return; await api.requestPasswordReset({ email }); setMessage("If that account exists, a reset link is on its way."); setScreen("reset-confirm"); }); }}>
              <label>Email<input required type="email" value={email} autoComplete="email" onChange={(event) => setEmail(event.target.value)} /></label>
              <button className="onboarding-primary" disabled={busy}>{busy ? "Sending…" : "Send reset link"}</button>
              <button type="button" className="onboarding-text-button" onClick={() => setScreen("sign-in")}>Back to sign in</button>
            </form> : null}

            {screen === "reset-confirm" ? <form onSubmit={(event) => { event.preventDefault(); void run(async () => { if (!api) return; if (pendingPasswordReset) await api.confirmPendingPasswordReset({ password }); else await api.confirmPasswordReset({ token: resetToken, password }); setPassword(""); setResetToken(""); setPendingPasswordReset(false); setScreen("sign-in"); setMessage("Password reset. Sign in with your new password."); }); }}>
              <p className="onboarding-detail">{pendingPasswordReset ? "Your password-reset link opened securely in Trace." : "Open the reset link in your email, then paste its code here if Trace did not open automatically."}</p>
              {!pendingPasswordReset ? <label>Reset code<input required value={resetToken} onChange={(event) => setResetToken(event.target.value)} /></label> : null}
              <label>New password<input required type="password" minLength={12} value={password} autoComplete="new-password" aria-describedby="password-requirement" onChange={(event) => setPassword(event.target.value)} /><small id="password-requirement">At least 12 characters.</small></label>
              <button className="onboarding-primary" disabled={busy}>{busy ? "Resetting…" : "Set new password"}</button>
            </form> : null}

            {screen === "github" ? <>
              <p className="onboarding-detail"><GitFork aria-hidden="true" />Your existing local GitHub credential is never sent to Trace.</p>
              <button className="onboarding-primary" disabled={busy} onClick={() => void run(async () => { if (!api) return; await api.beginGitHubLink(); setMessage("GitHub opened in your browser. Complete the connection, then return to Trace."); })}>{busy ? "Opening GitHub…" : "Connect GitHub"}</button>
              <button type="button" className="onboarding-text-button" disabled={busy} onClick={() => void run(async () => { if (!api) return; const result = await api.refreshState(); if (result.user?.githubLinked) { setAccount(result.user); setScreen(intent === "invitee" ? "complete" : "installation"); } else setMessage("GitHub is not connected yet. Finish the browser flow, then try again."); })}>I connected GitHub</button>
            </> : null}

            {screen === "installation" ? <>
              <p className="onboarding-detail">Install the Trace GitHub App on the account or organization that owns the repository. The Trace service will access it, not this Mac.</p>
              <button type="button" className="onboarding-secondary" disabled={busy} onClick={() => void run(async () => { if (!api) return; await api.openGitHubAppInstall(); setMessage("GitHub opened in your browser. Install Trace, then refresh GitHub access below."); })}>Install Trace GitHub App</button>
              <div className="onboarding-list" role="radiogroup" aria-label="GitHub App installations">
                {installations.map((installation) => <label key={installation.id} className={selectedInstallation === installation.id ? "is-selected" : ""}><input type="radio" name="installation" checked={selectedInstallation === installation.id} onChange={() => setSelectedInstallation(installation.id)} /><span>{installation.accountLogin}<small>{installation.accountType}</small></span></label>)}
                {!busy && installations.length === 0 ? <p className="onboarding-note">No installations found yet.</p> : null}
              </div>
              <button className="onboarding-primary" disabled={busy || !selectedInstallation} onClick={() => void run(() => loadRepositories(selectedInstallation))}>Choose repository</button>
              <div className="onboarding-form-links">
                <button type="button" className="onboarding-text-button" disabled={busy} onClick={() => void run(async () => { if (!api) return; await api.beginGitHubLink(); setScreen("github"); setMessage("GitHub opened to refresh the installations you can access. Complete it, then return to Trace."); })}>Refresh GitHub access</button>
                <button type="button" className="onboarding-text-button" disabled={busy} onClick={() => void run(loadInstallations)}>Refresh list</button>
              </div>
            </> : null}

            {screen === "repository" ? <>
              <div className="onboarding-list" role="radiogroup" aria-label="GitHub repositories">
                {repositories.map((repository) => <label key={repository.id} className={selectedRepository?.id === repository.id ? "is-selected" : ""}><input type="radio" name="repository" checked={selectedRepository?.id === repository.id} onChange={() => setSelectedRepository(repository)} /><span>{repository.owner}/{repository.name}<small>{repository.defaultBranch}{repository.private ? " · private" : ""}</small></span></label>)}
              </div>
              <button className="onboarding-primary" disabled={!selectedRepository} onClick={() => { setWorkspaceName(selectedRepository?.name ?? ""); setScreen("workspace"); }}>Continue</button>
              <button type="button" className="onboarding-text-button" onClick={() => setScreen("installation")}>Back</button>
            </> : null}

            {screen === "workspace" ? <form onSubmit={(event) => { event.preventDefault(); void run(async () => { if (!api || !selectedRepository) return; const result = await api.createWorkspace({ name: workspaceName, installationId: selectedInstallation, repository: selectedRepository }); setWorkspace({ id: result.workspace.id, name: result.workspace.name }); setScreen("invite"); }); }}>
              <p className="onboarding-detail">This binds the existing repository to a new Trace cloud workspace. Your local folders are not automatically uploaded.</p>
              <label>Workspace name<input required value={workspaceName} maxLength={80} onChange={(event) => setWorkspaceName(event.target.value)} /></label>
              <button className="onboarding-primary" disabled={busy}>{busy ? "Creating…" : "Create workspace"}</button>
            </form> : null}

            {screen === "invite" ? <>
              <p className="onboarding-detail">Invite a teammate by email. They’ll verify their account, redeem this one-time link, then can connect GitHub after entering.</p>
              <form onSubmit={(event) => { event.preventDefault(); void run(async () => { if (!api || !workspace) return; const result = await api.createInvite({ workspaceId: workspace.id, email: inviteEmail, expiresInSeconds: 7 * 24 * 60 * 60 }); setInviteLink(result.invite.link ?? null); setInviteEmail(""); setMessage("Invite created and emailed."); }); }}>
                <label>Teammate email<input required type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} /></label>
                <button className="onboarding-secondary" disabled={busy}>{busy ? "Sending…" : "Send invite"}</button>
              </form>
              {inviteLink ? <div className="onboarding-invite-link"><input value={inviteLink} readOnly aria-label="Invite link" /><button type="button" onClick={() => { void navigator.clipboard?.writeText(inviteLink); setMessage("Invite link copied."); }}>Copy</button></div> : null}
              <button className="onboarding-primary" onClick={() => setScreen("complete")}>Finish setup</button>
            </> : null}

            {screen === "redeem" ? <form onSubmit={(event) => { event.preventDefault(); void run(async () => { if (!api) return; const result = pendingInvite ? await api.redeemPendingInvite() : await api.redeemInvite({ tokenOrLink: inviteCode }); setWorkspace({ id: result.workspace.id, name: result.workspace.name }); setPendingInvite(false); setInviteCode(""); setScreen("complete"); }); }}>
              <p className="onboarding-detail">{pendingInvite ? "This invitation was opened securely in Trace. Join it when you’re ready." : "Paste the invite link or its one-time code from your email."}</p>
              {!pendingInvite ? <label>Invite link or code<input required value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} /></label> : null}
              <button className="onboarding-primary" disabled={busy}>{busy ? "Joining…" : pendingInvite ? "Join invitation" : "Join workspace"}</button>
            </form> : null}

            {screen === "complete" ? <>
              <p className="onboarding-detail"><strong>{workspace?.name ?? "Your workspace"}</strong> is ready in Trace. Cloud workspace sync is kept separate from local folders; open a local folder whenever you want to work locally.</p>
              {intent === "invitee" && !account?.githubLinked ? <button type="button" className="onboarding-secondary" onClick={() => setScreen("github")}>Connect GitHub</button> : null}
              <button className="onboarding-primary" onClick={onContinueLocal}>Open a local folder</button>
              <button type="button" className="onboarding-text-button" onClick={returnToStart}>Back to start</button>
            </> : null}
              </motion.div>
            </AnimatePresence>
          </div>
        </main>
      </motion.div> : null}
    </section>
  );
}
