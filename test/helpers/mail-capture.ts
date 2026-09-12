import type {
  EmailAttachment,
  EmailDispatcher,
  EmailOptions,
  Provider,
} from "src/modules/email/email-provider-selection";

/** One outbound message, as the transport received it. */
export interface CapturedMail {
  /** Normalised exactly as the real provider normalises: trimmed, empties dropped. */
  to: string[];
  subject: string;
  html: string;
  text?: string;
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  headers?: Record<string, string>;
  attachments?: EmailAttachment[];
  organizationId?: string | null;
  /**
   * Which entry point the caller used.
   *
   * `EmailOutboxService.enqueueAndTry` send-throughs on `sendEmailOnceDirect`,
   * while `EmailSendersBase.sendEmail` goes to `dispatchEmail` (which retries
   * and may fall back to a second provider). A spec asserting "this was a
   * single attempt, not the retry loop" needs to tell the two apart.
   */
  via: "dispatchEmail" | "sendEmailOnceDirect";
  at: Date;
}

/**
 * `normalizeRecipients` from `email.provider.ts`, which is not exported.
 *
 * Duplicated deliberately rather than approximated: the real transport drops
 * empty and whitespace-only addresses before deciding whether it has anyone to
 * send to, so a capture that recorded them would report a message the provider
 * would never have sent, and a spec asserting "no mail for a party with no
 * address" would go green against a transport that behaves differently.
 */
function normalizeRecipients(to: string | string[]): string[] {
  const arr = Array.isArray(to) ? to : [to];
  return arr.map((s) => s.trim()).filter(Boolean);
}

/**
 * An in-memory stand-in for `EmailProviderService` in seeded e2e runs.
 *
 * `jest-e2e-seeded.json` sets `setupFiles: ["dotenv/config"]`, so the real
 * `.env` — with `EMAIL_PROVIDER=resend` and a live `RESEND_API_KEY` — is loaded
 * into every seeded run. Nothing stubbed the transport, so any seeded spec that
 * sent mail made a genuine Resend API call against production quota. The only
 * reason nothing was ever delivered is that the fixtures happen to use reserved
 * `.example` / `.invalid` recipients, which is the fixtures' luck rather than a
 * control: one real-looking address in one fixture and the suite mails a person.
 *
 * Implements `EmailDispatcher` — the interface the module already declares for
 * "what a consumer actually needs from the provider" — so the three call sites
 * that inject `EmailProviderService` see the surface they expect.
 */
export class CapturingMailTransport implements EmailDispatcher {
  private readonly sent: CapturedMail[] = [];

  /**
   * Deliberately not `"none"`.
   *
   * `EmailOutboxService.enqueueAndTry`, `AutomationEmailService.send` and
   * `HrSendEmailController` all branch on `getEmailProvider() === "none"` and
   * skip (or hard-fail) the send. A capture reporting "none" would turn every
   * one of those into a no-op, record nothing, and leave the suite asserting
   * against a transport that was never reached — green, and vacuous. Reporting
   * the provider the run is actually configured for keeps the code path under
   * test identical to production, minus the socket.
   */
  constructor(private readonly provider: Provider = "resend") {}

  getEmailProvider(): Provider {
    return this.provider;
  }

  async sendEmailOnceDirect(options: EmailOptions): Promise<void> {
    this.record(options, "sendEmailOnceDirect");
  }

  async dispatchEmail(options: EmailOptions): Promise<void> {
    this.record(options, "dispatchEmail");
  }

  private record(options: EmailOptions, via: CapturedMail["via"]): void {
    const to = normalizeRecipients(options.to);
    /** The real transport logs EMAIL_SKIPPED and returns without sending. */
    if (to.length === 0) return;

    const cc = options.cc ? normalizeRecipients(options.cc) : undefined;
    const bcc = options.bcc ? normalizeRecipients(options.bcc) : undefined;

    this.sent.push({
      to,
      subject: options.subject,
      html: options.html,
      ...(options.text !== undefined ? { text: options.text } : {}),
      ...(cc?.length ? { cc } : {}),
      ...(bcc?.length ? { bcc } : {}),
      ...(options.replyTo !== undefined ? { replyTo: options.replyTo } : {}),
      ...(options.headers !== undefined ? { headers: options.headers } : {}),
      ...(options.attachments?.length ? { attachments: options.attachments } : {}),
      ...(options.organizationId !== undefined
        ? { organizationId: options.organizationId }
        : {}),
      via,
      at: new Date(),
    });
  }

  /** Every message the transport was handed, oldest first. */
  get messages(): readonly CapturedMail[] {
    return this.sent;
  }

  get count(): number {
    return this.sent.length;
  }

  /** Messages addressed to `email` on any of to/cc/bcc, oldest first. */
  to(email: string): CapturedMail[] {
    const needle = email.trim().toLowerCase();
    const hit = (list: string[] | undefined): boolean =>
      (list ?? []).some((a) => a.toLowerCase() === needle);
    return this.sent.filter((m) => hit(m.to) || hit(m.cc) || hit(m.bcc));
  }

  /** Messages whose subject contains `text`, case-insensitively. */
  withSubject(text: string): CapturedMail[] {
    const needle = text.toLowerCase();
    return this.sent.filter((m) => m.subject.toLowerCase().includes(needle));
  }

  last(): CapturedMail | undefined {
    return this.sent[this.sent.length - 1];
  }

  /**
   * Drop everything captured so far.
   *
   * A seeded suite shares one app across its `it`s, so a spec that wants
   * "exactly one mail went out for this action" resets first rather than
   * counting around whatever the preceding tests happened to send.
   */
  reset(): void {
    this.sent.length = 0;
  }
}
