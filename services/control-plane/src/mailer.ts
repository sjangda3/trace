export type VerificationMail = { to: string; displayName: string; verificationUrl: string };
export type PasswordResetMail = { to: string; displayName: string; resetUrl: string };
export type WorkspaceInviteMail = { to: string; workspaceName: string; inviterName: string; inviteUrl: string; expiresAt: string };

export interface AccountMailer {
  sendVerification(input: VerificationMail): Promise<void>;
  sendPasswordReset(input: PasswordResetMail): Promise<void>;
  sendWorkspaceInvite(input: WorkspaceInviteMail): Promise<void>;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

export class ResendAccountMailer implements AccountMailer {
  constructor(
    private readonly options: { apiKey: string; from: string; fetch?: typeof fetch },
  ) {}

  async sendVerification(input: VerificationMail): Promise<void> {
    await this.#send(input.to, "Verify your Trace email", `<p>Hi ${escapeHtml(input.displayName)},</p><p>Verify your email to finish setting up Trace.</p><p><a href="${escapeHtml(input.verificationUrl)}">Verify email</a></p>`);
  }

  async sendPasswordReset(input: PasswordResetMail): Promise<void> {
    await this.#send(input.to, "Reset your Trace password", `<p>Hi ${escapeHtml(input.displayName)},</p><p><a href="${escapeHtml(input.resetUrl)}">Reset password</a></p>`);
  }

  async sendWorkspaceInvite(input: WorkspaceInviteMail): Promise<void> {
    await this.#send(input.to, `You've been invited to ${input.workspaceName} on Trace`, `<p>${escapeHtml(input.inviterName)} invited you to <strong>${escapeHtml(input.workspaceName)}</strong> on Trace.</p><p><a href="${escapeHtml(input.inviteUrl)}">Open invitation</a></p><p>This link expires ${escapeHtml(input.expiresAt)}.</p>`);
  }

  async #send(to: string, subject: string, html: string): Promise<void> {
    const request = this.options.fetch ?? globalThis.fetch;
    const response = await request("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.options.from, to: [to], subject, html }),
    });
    if (!response.ok) throw new Error("Resend could not deliver the email.");
  }
}

/** Deterministic delivery sink for development and tests. It intentionally never logs token-bearing URLs. */
export class InMemoryAccountMailer implements AccountMailer {
  readonly verification: VerificationMail[] = [];
  readonly passwordResets: PasswordResetMail[] = [];
  readonly workspaceInvites: WorkspaceInviteMail[] = [];
  async sendVerification(input: VerificationMail): Promise<void> { this.verification.push(structuredClone(input)); }
  async sendPasswordReset(input: PasswordResetMail): Promise<void> { this.passwordResets.push(structuredClone(input)); }
  async sendWorkspaceInvite(input: WorkspaceInviteMail): Promise<void> { this.workspaceInvites.push(structuredClone(input)); }
}
