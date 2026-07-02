import { Resend } from "resend";
import sgMail, { type MailDataRequired } from "@sendgrid/mail";
import { logger } from "../../common/logger/logger.service";
import { getFromAddress } from "./email.constants";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const EMAIL_PROVIDER_PREFERENCE = process.env.EMAIL_PROVIDER?.toLowerCase().trim();

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;
if (SENDGRID_API_KEY) sgMail.setApiKey(SENDGRID_API_KEY);

export type Provider = "resend" | "sendgrid" | "none";

export interface EmailAttachment {
  filename: string;
  content: Buffer | string;
  type: string;
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
}

function resolveProvider(): Provider {
  if (EMAIL_PROVIDER_PREFERENCE === "sendgrid" && SENDGRID_API_KEY) return "sendgrid";
  if (EMAIL_PROVIDER_PREFERENCE === "resend" && resend) return "resend";
  if (resend) return "resend";
  if (SENDGRID_API_KEY) return "sendgrid";
  return "none";
}

const activeProvider: Provider = resolveProvider();

export function getEmailProvider(): Provider {
  return activeProvider;
}

function normalizeRecipients(to: string | string[]): string[] {
  const arr = Array.isArray(to) ? to : [to];
  return arr.map((s) => s.trim()).filter(Boolean);
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function isTransientError(error: unknown): boolean {
  if (!error || typeof error !== "object") return true;
  const code = (error as { code?: number | string }).code;
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return true;
  }
  const statusCode =
    (error as { statusCode?: number }).statusCode ??
    (typeof code === "number" ? code : undefined);
  if (typeof statusCode === "number") {
    if (statusCode >= 500 && statusCode < 600) return true;
    if (statusCode >= 400 && statusCode < 500) return false;
  }
  return true;
}

const delay = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

async function sendViaResend(options: EmailOptions): Promise<void> {
  if (!resend) throw new Error("Resend not initialized");

  const recipients = normalizeRecipients(options.to);
  const text = options.text || htmlToText(options.html);
  const attachments = options.attachments?.map((a) => ({
    filename: a.filename,
    content: Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content),
    contentType: a.type,
  }));

  const cc = options.cc ? normalizeRecipients(options.cc) : undefined;
  const bcc = options.bcc ? normalizeRecipients(options.bcc) : undefined;

  const { data, error } = await resend.emails.send({
    from: getFromAddress(),
    to: recipients,
    subject: options.subject,
    html: options.html,
    text,
    ...(options.replyTo ? { replyTo: options.replyTo } : {}),
    ...(cc?.length ? { cc } : {}),
    ...(bcc?.length ? { bcc } : {}),
    ...(attachments?.length ? { attachments } : {}),
  });

  if (error) {
    const err = error as { statusCode?: number; name?: string; message?: string };
    const wrapped = new Error(err.message || "Resend send failed");
    (wrapped as { statusCode?: number }).statusCode = err.statusCode;
    throw wrapped;
  }

  logger.info("Email sent (resend)", { to: recipients, subject: options.subject, id: data?.id });
}

async function sendViaSendgrid(options: EmailOptions): Promise<void> {
  const recipients = normalizeRecipients(options.to);
  const attachments = options.attachments?.map((a) => ({
    content: Buffer.isBuffer(a.content) ? a.content.toString("base64") : a.content,
    filename: a.filename,
    type: a.type,
    disposition: "attachment" as const,
  }));

  const sgCc = options.cc ? normalizeRecipients(options.cc) : undefined;
  const sgBcc = options.bcc ? normalizeRecipients(options.bcc) : undefined;

  const msg: MailDataRequired = {
    to: recipients.length === 1 ? recipients[0] : recipients,
    from: getFromAddress(),
    subject: options.subject,
    html: options.html,
    text: options.text || htmlToText(options.html),
    ...(options.replyTo ? { replyTo: options.replyTo } : {}),
    ...(sgCc?.length ? { cc: sgCc.length === 1 ? sgCc[0] : sgCc } : {}),
    ...(sgBcc?.length ? { bcc: sgBcc.length === 1 ? sgBcc[0] : sgBcc } : {}),
    ...(attachments?.length ? { attachments } : {}),
  };

  await sgMail.send(msg);
  logger.info("Email sent (sendgrid)", { to: recipients, subject: options.subject });
}

function providerStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { statusCode?: number }).statusCode;
  return typeof code === "number" ? code : undefined;
}

async function sendWithProvider(provider: Provider, options: EmailOptions): Promise<void> {
  if (provider === "resend") {
    await sendViaResend(options);
    return;
  }
  if (provider === "sendgrid") {
    await sendViaSendgrid(options);
    return;
  }
  throw new Error("No email provider configured");
}

export async function sendEmailOnceDirect(options: EmailOptions): Promise<void> {
  const recipients = normalizeRecipients(options.to);
  if (recipients.length === 0) {
    logger.warn("EMAIL_SKIPPED: no recipients", { subject: options.subject });
    return;
  }
  await sendWithProvider(activeProvider, { ...options, to: recipients });
}

export async function dispatchEmail(options: EmailOptions): Promise<void> {
  const recipients = normalizeRecipients(options.to);
  if (recipients.length === 0) {
    logger.warn("EMAIL_SKIPPED: no recipients", { subject: options.subject });
    return;
  }
  if (activeProvider === "none") {
    logger.warn("EMAIL_SKIPPED: no email provider configured", {
      to: recipients,
      subject: options.subject,
      hint: "Set EMAIL_PROVIDER + SENDGRID_API_KEY (or RESEND_API_KEY) in .env",
    });
    throw new Error("No email provider configured");
  }

  const fallbackProvider: Provider | null =
    activeProvider === "resend" && SENDGRID_API_KEY
      ? "sendgrid"
      : activeProvider === "sendgrid" && resend
        ? "resend"
        : null;

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await sendWithProvider(activeProvider, options);
      return;
    } catch (error) {
      lastError = error;
      const status = providerStatusCode(error);
      if (
        fallbackProvider &&
        status !== undefined &&
        status >= 400 &&
        status < 500
      ) {
        logger.warn("Email primary provider rejected send; trying fallback", {
          primary: activeProvider,
          fallback: fallbackProvider,
          to: recipients,
          subject: options.subject,
          status,
        });
        try {
          await sendWithProvider(fallbackProvider, options);
          return;
        } catch (fallbackError) {
          lastError = fallbackError;
          logger.error("Email fallback provider failed", {
            fallback: fallbackProvider,
            to: recipients,
            subject: options.subject,
            error: fallbackError,
          });
          throw fallbackError;
        }
      }
      if (!isTransientError(error)) {
        logger.error("Email send failed (non-retryable)", {
          provider: activeProvider,
          to: recipients,
          subject: options.subject,
          attempt,
          error,
        });
        throw error;
      }
      if (attempt < MAX_RETRIES) {
        const backoff = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        logger.warn(`Email retry ${attempt}/${MAX_RETRIES}`, {
          provider: activeProvider,
          to: recipients,
          subject: options.subject,
          nextRetryMs: backoff,
        });
        await delay(backoff);
      }
    }
  }

  logger.error("Email send failed after all retries", {
    provider: activeProvider,
    to: options.to,
    subject: options.subject,
    error: lastError,
  });
  throw lastError;
}
