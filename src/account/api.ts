import type { RawResult } from "../editor/bridge";
import type { TraceAccountBridge } from "./types";

export class TraceAccountError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "TraceAccountError"; }
}

function unwrap<T>(result: RawResult<T>): T {
  if (result.ok) return result.value;
  throw new TraceAccountError(result.error.code, result.error.message);
}

class ElectronTraceAccountApi {
  constructor(private readonly bridge: TraceAccountBridge) {}
  state = () => this.bridge.state().then(unwrap);
  signUp = (request: { email: string; displayName: string; password: string }) => this.bridge.signUp(request).then(unwrap);
  signIn = (request: { email: string; password: string }) => this.bridge.signIn(request).then(unwrap);
  resendVerification = (request: { email: string }) => this.bridge.resendVerification(request).then(unwrap);
  requestPasswordReset = (request: { email: string }) => this.bridge.requestPasswordReset(request).then(unwrap);
  confirmPasswordReset = (request: { token: string; password: string }) => this.bridge.confirmPasswordReset(request).then(unwrap);
  refreshState = () => this.bridge.refreshState().then(unwrap);
  signOut = () => this.bridge.signOut().then(unwrap);
  beginGitHubLink = () => this.bridge.beginGitHubLink().then(unwrap);
  openGitHubAppInstall = () => this.bridge.openGitHubAppInstall().then(unwrap);
  listInstallations = () => this.bridge.listInstallations().then(unwrap);
  listRepositories = (installationId: string) => this.bridge.listRepositories(installationId).then(unwrap);
  createWorkspace = (request: Parameters<TraceAccountBridge["createWorkspace"]>[0]) => this.bridge.createWorkspace(request).then(unwrap);
  createInvite = (request: Parameters<TraceAccountBridge["createInvite"]>[0]) => this.bridge.createInvite(request).then(unwrap);
  redeemInvite = (request: { tokenOrLink: string }) => this.bridge.redeemInvite(request).then(unwrap);
  pendingInvite = () => this.bridge.pendingInvite().then(unwrap);
  redeemPendingInvite = () => this.bridge.redeemPendingInvite().then(unwrap);
  pendingPasswordReset = () => this.bridge.pendingPasswordReset().then(unwrap);
  confirmPendingPasswordReset = (request: { password: string }) => this.bridge.confirmPendingPasswordReset(request).then(unwrap);
  onDeepLink = (callback: (event: { kind: "invite" | "password-reset" }) => void) => this.bridge.onDeepLink(callback);
}

export const traceAccountApi = typeof window === "undefined" || !window.traceAccount ? null : new ElectronTraceAccountApi(window.traceAccount);
