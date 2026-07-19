import { Resend } from "resend";
import nodemailer, { type Transporter } from "nodemailer";
import { logger } from "../../common/logger/logger.service";
import { getFromAddress } from "./email.constants";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ZEPTOMAIL_SMTP_HOST = process.env.ZEPTOMAIL_SMTP_HOST?.trim() || "smtp.zeptomail.in";
const ZEPTOMAIL_SMTP_PORT = Number(process.env.ZEPTOMAIL_SMTP_PORT) || 587;
const ZEPTOMAIL_SMTP_USER = process.env.ZEPTOMAIL_SMTP_USER?.trim() || "emailapikey";
const ZEPTOMAIL_SMTP_PASS = process.env.ZEPTOMAIL_SMTP_PASS?.trim();
const EMAIL_PROVIDER_PREFERENCE = process.env.EMAIL_PROVIDER?.toLowerCase().trim();

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

const zeptomailTransport: Transporter | null = ZEPTOMAIL_SMTP_PASS
  ? nodemailer.createTransport({
      host: ZEPTOMAIL_SMTP_HOST,
      port: ZEPTOMAIL_SMTP_PORT,
      secure: ZEPTOMAIL_SMTP_PORT === 465,
      requireTLS: ZEPTOMAIL_SMTP_PORT !== 465,
      pool: true,
      maxConnections: 3,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
      auth: { user: ZEPTOMAIL_SMTP_USER, pass: ZEPTOMAIL_SMTP_PASS },
    })
  : null;

export type Provider = "zeptomail" | "resend" | "none";

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
}

class EmailSendError extends Error {
  readonly permanent: boolean;

  constructor(message: string, permanent: boolean, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "EmailSendError";
    this.permanent = permanent;
  }
}

function resolveProvider(): Provider {
  if (EMAIL_PROVIDER_PREFERENCE === "zeptomail" && zeptomailTransport) return "zeptomail";
  if (EMAIL_PROVIDER_PREFERENCE === "resend" && resend) return "resend";
  if (zeptomailTransport) return "zeptomail";
  if (resend) return "resend";
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
  if (error instanceof EmailSendError) return !error.permanent;
  if (!error || typeof error !== "object") return true;
  const code = (error as { code?: number | string }).code;
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ECONNECTION") {
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
  if (!resend) throw new EmailSendError("Resend not initialized", true);

  const recipients = normalizeRecipients(options.to);
  const text = options.text || htmlToText(options.html);
  const attachments = options.attachments?.map((a) => ({
    filename: a.filename,
    content: Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content),
    contentType: a.type,
    ...(a.cid ? { contentId: a.cid } : {}),
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
    const status = err.statusCode;
    const permanent = typeof status === "number" && status >= 400 && status < 500;
    throw new EmailSendError(err.message || "Resend send failed", permanent, error);
  }

  logger.info("Email sent (resend)", { to: recipients, subject: options.subject, id: data?.id });
}

function smtpErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "ZeptoMail SMTP send failed";
}

function isPermanentSmtpError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const responseCode = (error as { responseCode?: number }).responseCode;
  return typeof responseCode === "number" && responseCode >= 500 && responseCode < 600;
}

async function sendViaZeptomail(options: EmailOptions): Promise<void> {
  if (!zeptomailTransport) throw new EmailSendError("ZeptoMail transport not initialized", true);

  const recipients = normalizeRecipients(options.to);
  const attachments = options.attachments?.map((a) => ({
    filename: a.filename,
    content: Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content),
    contentType: a.type,
    ...(a.cid ? { cid: a.cid } : {}),
    ...(a.disposition ? { contentDisposition: a.disposition } : {}),
  }));

  const cc = options.cc ? normalizeRecipients(options.cc) : undefined;
  const bcc = options.bcc ? normalizeRecipients(options.bcc) : undefined;

  try {
    const info = await zeptomailTransport.sendMail({
      from: getFromAddress(),
      to: recipients,
      subject: options.subject,
      html: options.html,
      text: options.text || htmlToText(options.html),
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
      ...(cc?.length ? { cc } : {}),
      ...(bcc?.length ? { bcc } : {}),
      ...(attachments?.length ? { attachments } : {}),
    });
    logger.info("Email sent (zeptomail)", { to: recipients, subject: options.subject, id: info.messageId });
  } catch (error) {
    throw new EmailSendError(smtpErrorMessage(error), isPermanentSmtpError(error), error);
  }
}

async function sendWithProvider(provider: Provider, options: EmailOptions): Promise<void> {
  if (provider === "zeptomail") {
    await sendViaZeptomail(options);
    return;
  }
  if (provider === "resend") {
    await sendViaResend(options);
    return;
  }
  throw new EmailSendError("No email provider configured", true);
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
      hint: "Set EMAIL_PROVIDER + ZEPTOMAIL_SMTP_PASS (or RESEND_API_KEY) in .env",
    });
    throw new EmailSendError("No email provider configured", true);
  }

  const fallbackProvider: Provider | null =
    activeProvider === "zeptomail" && resend
      ? "resend"
      : activeProvider === "resend" && zeptomailTransport
        ? "zeptomail"
        : null;

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await sendWithProvider(activeProvider, options);
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientError(error)) {
        if (fallbackProvider) {
          logger.warn("Email primary provider rejected send; trying fallback", {
            primary: activeProvider,
            fallback: fallbackProvider,
            to: recipients,
            subject: options.subject,
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
