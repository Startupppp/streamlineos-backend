export type Provider = "zeptomail" | "resend" | "none";

export type ProviderPreference = "zeptomail" | "resend" | undefined;

export function selectProvider(
  preference: ProviderPreference,
  hasZeptomail: boolean,
  hasResend: boolean,
): Provider {
  if (preference === "zeptomail" && hasZeptomail) return "zeptomail";
  if (preference === "resend" && hasResend) return "resend";
  if (hasZeptomail) return "zeptomail";
  if (hasResend) return "resend";
  return "none";
}

export function fallbackProvider(
  active: Provider,
  hasZeptomail: boolean,
  hasResend: boolean,
): Provider | null {
  if (active === "zeptomail" && hasResend) return "resend";
  if (active === "resend" && hasZeptomail) return "zeptomail";
  return null;
}

/** What a consumer actually needs from the provider; lets a spec pass a plain object. */
export interface EmailDispatcher {
  getEmailProvider(): Provider;
  sendEmailOnceDirect(options: EmailOptions, budgetMs?: number): Promise<void>;
  dispatchEmail(options: EmailOptions): Promise<void>;
}

export interface EmailAttachment {
  filename: string;
  content: Buffer | string;
  type: string;
  cid?: string;
  disposition?: "inline" | "attachment";
}

export interface EmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  attachments?: EmailAttachment[];
  replyTo?: string;
  cc?: string | string[];
  bcc?: string | string[];
  organizationId?: string | null;
  /** Set only on non-mandatory mail - a payslip must not advertise an opt-out it will not honour. */
  headers?: Record<string, string>;
  /**
   * When set together with organizationId, the retry worker checks that this user is
   * still an active org member before re-sending. Use for employment-sensitive mail
   * (payslips, employment letters) that must not reach offboarded recipients.
   */
  recipientUserId?: string | null;
}
