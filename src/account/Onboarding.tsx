import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, ChevronLeft, FolderOpen, GitFork } from "lucide-react";
import { traceAccountApi, TraceAccountError } from "./api";
import {
  OpeningShaderBackground,
  type OpeningTransitionDirection,
  type OpeningTransitionTarget,
} from "./OpeningShaderBackground";
import type { CloudRepository, GitHubAppInstallation, TraceAccount } from "./types";
import { afterVerificationRefresh, type OnboardingIntent, type OnboardingScreen } from "./onboarding-state";

type Screen = OnboardingScreen | "reset-request" | "reset-confirm" | "repository" | "workspace" | "invite" | "complete";
type Intent = OnboardingIntent;
type ConcreteOpeningTarget = Exclude<OpeningTransitionTarget, null>;
type OpeningTransition = {
  target: ConcreteOpeningTarget;
  direction: OpeningTransitionDirection;
};

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

export function Onboarding({ onContinueLocal }: { onContinueLocal: () => void }) {
  const api = traceAccountApi;
  const [screen, setScreen] = useState<Screen>("choice");
  const [intent, setIntent] = useState<Intent>("owner");
  const [account, setAccount] = useState<TraceAccount | null>(null);
  const [availability, setAvailability] = useState<"loading" | "ready" | "not-configured">(api ? "loading" : "not-configured");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
  const [openingTransition, setOpeningTransition] = useState<OpeningTransition | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const onboardingRef = useRef<HTMLElement>(null);

  const cloudReady = availability === "ready" && Boolean(api);
  const details = useMemo(() => screenDetails(screen), [screen]);
  const activeStep = activeStepFor(screen);
  const screenOpeningTarget: ConcreteOpeningTarget | null = screen === "sign-in"
    ? "login"
    : screen === "sign-up"
      ? "signup"
      : null;
  const activeOpeningTarget = openingTransition?.target ?? screenOpeningTarget;
  const activeOpeningDirection = openingTransition?.direction ?? "forward";
  const isOpeningCanvas = screen === "choice" || Boolean(screenOpeningTarget) || Boolean(openingTransition);

  useEffect(() => {
    if (screenOpeningTarget) onboardingRef.current?.focus();
    else if (screen !== "choice") headingRef.current?.focus();
  }, [screen, screenOpeningTarget]);

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
        setMessage("A Trace invitation is ready. Sign in or create an account to join it.");
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
        setMessage("A Trace invitation is ready. Sign in or create an account to join it.");
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

  const returnToStart = () => {
    setIntent("owner");
    setMessage(null);
    setOpeningTransition(null);
    setScreen("choice");
  };

  const beginOpeningTransition = (target: ConcreteOpeningTarget) => {
    if (openingTransition) return;
    setIntent("owner");
    setMessage(null);
    setOpeningTransition({ target, direction: "forward" });
  };

  const beginOpeningReturnTransition = () => {
    if (!screenOpeningTarget || openingTransition) return;
    setIntent("owner");
    setMessage(null);
    setOpeningTransition({ target: screenOpeningTarget, direction: "reverse" });
  };

  const finishOpeningTransition = (target: ConcreteOpeningTarget, direction: OpeningTransitionDirection) => {
    setOpeningTransition(null);
    if (direction === "reverse") {
      setScreen("choice");
      return;
    }
    setScreen(target === "login" ? "sign-in" : "sign-up");
  };

  useEffect(() => {
    if (!screenOpeningTarget) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || openingTransition) return;
      setIntent("owner");
      setMessage(null);
      setOpeningTransition({ target: screenOpeningTarget, direction: "reverse" });
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [openingTransition, screenOpeningTarget]);

  return (
    <section
      ref={onboardingRef}
      className={`onboarding${isOpeningCanvas ? " onboarding--opening" : ""}`}
      data-onboarding-screen={screen}
      data-wave-target={activeOpeningTarget ?? undefined}
      data-wave-transition={openingTransition?.direction === "reverse" ? "reverse" : undefined}
      aria-label={screenOpeningTarget === "login" ? "Login" : screenOpeningTarget === "signup" ? "Sign up" : undefined}
      aria-labelledby={isOpeningCanvas ? undefined : "onboarding-title"}
      tabIndex={screenOpeningTarget ? -1 : undefined}
    >
      {isOpeningCanvas ? <OpeningShaderBackground
        transitionTarget={activeOpeningTarget}
        transitionDirection={activeOpeningDirection}
        onTransitionComplete={finishOpeningTransition}
      /> : null}
      {screenOpeningTarget ? <button
        type="button"
        className="onboarding-opening-back"
        disabled={Boolean(openingTransition)}
        onClick={beginOpeningReturnTransition}
      >
        <ArrowLeft aria-hidden="true" />
        <span>Back</span>
      </button> : null}
      {screen === "choice" ? <div
        className={`onboarding-opening-actions${openingTransition ? " is-exiting" : ""}`}
        aria-label="Account access"
      >
        <button
          type="button"
          className="onboarding-opening-action"
          disabled={Boolean(openingTransition)}
          onClick={() => beginOpeningTransition("login")}
        >
          Login
        </button>
        <button
          type="button"
          className="onboarding-opening-action onboarding-opening-action--primary"
          disabled={Boolean(openingTransition)}
          onClick={() => beginOpeningTransition("signup")}
        >
          Sign up
        </button>
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
            {screen === "verify" ? <>
              <p className="onboarding-detail">Check <strong>{email || "your inbox"}</strong> for a verification link. Once it opens in your browser, return here.</p>
              <button className="onboarding-primary" disabled={busy} onClick={() => void run(refreshAccount)}>{busy ? "Checking…" : "I verified my email"}</button>
              <div className="onboarding-form-links">
                <button type="button" className="onboarding-text-button" disabled={busy || !email} onClick={() => void run(async () => { if (!api) return; await api.resendVerification({ email }); setMessage("A new verification email is on its way."); })}>Resend verification email</button>
                <button type="button" className="onboarding-text-button" onClick={() => setScreen("sign-in")}>Back to sign in</button>
              </div>
            </> : null}

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
