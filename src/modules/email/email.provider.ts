import { Inject, Injectable } from "@nestjs/common";
import { Resend } from "resend";
import { SendMailClient } from "zeptomail";
import { logger } from "../../common/logger/logger.service";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";
import { getFromAddress, getFromParts } from "./email.constants";
import {
  fallbackProvider,
  selectProvider,
  type EmailOptions,
  type Provider,
} from "./email-provider-selection";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const ZEPTOMAIL_TIMEOUT_MS = 30_000;
const RESEND_TIMEOUT_MS = 30_000;
const ZEPTOMAIL_DEFAULT_URL = "https://api.zeptomail.in/v1.1/email";

export type {
  EmailOptions,
  Provider,
} from "./email-provider-selection";

interface EmailClients {
  resend: Resend | null;
  zeptomail: SendMailClient | null;
}

function zeptomailToken(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith("Zoho-enczapikey")
    ? trimmed
    : `Zoho-enczapikey ${trimmed}`;
}

/**
 * `jest-e2e.json` loads the real `.env` through `dotenv/config`, so an e2e run
 * booted the app with a live ZeptoMail token and any spec reaching the real
 * `EmailService` delivered mail to real recipients — 14 provider-accepted sends
 * in one sweep before this guard. A test run must not be able to construct a
 * sender at all; refusing here rather than in a setup file means no new config,
 * suite or harness can reintroduce it.
 */
export function buildEmailClients(config: AppConfig): EmailClients {
  if (process.env.NODE_ENV === "test" && process.env.EMAIL_ALLOW_LIVE_SEND !== "1")
    return { resend: null, zeptomail: null };
  const token = zeptomailToken(config.ZEPTOMAIL_TOKEN);
  return {
    resend: config.RESEND_API_KEY ? new Resend(config.RESEND_API_KEY) : null,
    zeptomail: token
      ? new SendMailClient({
          url: config.ZEPTOMAIL_API_URL?.trim() || ZEPTOMAIL_DEFAULT_URL,
          token,
        })
      : null,
  };
}

class EmailSendError extends Error {
  readonly permanent: boolean;

  constructor(message: string, permanent: boolean, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "EmailSendError";
    this.permanent = permanent;
  }
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
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ECONNREFUSED") {
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

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new EmailSendError(`${label} timed out after ${ms}ms`, false)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (reason: unknown) => {
        clearTimeout(timer);
        reject(reason);
      },
    );
  });
}

async function sendViaResend(clients: EmailClients, options: EmailOptions): Promise<void> {
  const resend = clients.resend;
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

  const { data, error } = await withTimeout(
    resend.emails.send({
      from: getFromAddress(),
      to: recipients,
      subject: options.subject,
      html: options.html,
      text,
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
      ...(cc?.length ? { cc } : {}),
      ...(bcc?.length ? { bcc } : {}),
      ...(attachments?.length ? { attachments } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
    }),
    RESEND_TIMEOUT_MS,
    "Resend send",
  );

  if (error) {
    const err = error as { statusCode?: number; name?: string; message?: string };
    const status = err.statusCode;
    const permanent = typeof status === "number" && status >= 400 && status < 500;
    throw new EmailSendError(err.message || "Resend send failed", permanent, error);
  }

  logger.info("Email sent (resend)", { to: recipients, subject: options.subject, id: data?.id });
}

interface ZeptoErrorDetail {
  code?: string;
  message?: string;
  target?: string;
}

interface ZeptoErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: ZeptoErrorDetail[];
    request_id?: string;
  };
}

function zeptoRejectionToError(reason: unknown): EmailSendError {
  if (reason instanceof EmailSendError) return reason;
  if (typeof reason === "string") {
    return new EmailSendError(reason, true, reason);
  }
  if (reason instanceof Error) {
    return new EmailSendError(reason.message || "ZeptoMail send failed", false, reason);
  }
  if (reason && typeof reason === "object") {
    const body = reason as ZeptoErrorBody;
    if (body.error) {
      const detail = Array.isArray(body.error.details)
        ? body.error.details
            .map((d) => [d.target, d.message].filter(Boolean).join(": "))
            .filter(Boolean)
            .join("; ")
        : "";
      const message = [body.error.message, detail].filter(Boolean).join(" — ") || "ZeptoMail send failed";
      const permanent = body.error.code !== "TM_5001";
      return new EmailSendError(message, permanent, reason);
    }
  }
  return new EmailSendError("ZeptoMail send failed", false, reason);
}

function toBase64(content: Buffer | string): string {
  return Buffer.isBuffer(content) ? content.toString("base64") : content;
}

async function sendViaZeptomail(clients: EmailClients, options: EmailOptions): Promise<void> {
  const zeptomail = clients.zeptomail;
  if (!zeptomail) throw new EmailSendError("ZeptoMail client not initialized", true);

  const recipients = normalizeRecipients(options.to);
  const cc = options.cc ? normalizeRecipients(options.cc) : undefined;
  const bcc = options.bcc ? normalizeRecipients(options.bcc) : undefined;

  const inline = options.attachments?.filter((a) => a.cid) ?? [];
  const regular = options.attachments?.filter((a) => !a.cid) ?? [];

  const toItem = (address: string) => ({ email_address: { address, name: "" } });

  try {
    const response = await withTimeout(
      zeptomail.sendMail({
        from: getFromParts(),
        to: recipients.map(toItem),
        subject: options.subject,
        htmlbody: options.html,
        textbody: options.text || htmlToText(options.html),
        ...(options.replyTo ? { reply_to: [{ address: options.replyTo, name: "" }] } : {}),
        ...(cc?.length ? { cc: cc.map(toItem) } : {}),
        ...(bcc?.length ? { bcc: bcc.map(toItem) } : {}),
        ...(regular.length
          ? { attachments: regular.map((a) => ({ name: a.filename, mime_type: a.type, content: toBase64(a.content) })) }
          : {}),
        ...(inline.length
          ? { inline_images: inline.map((a) => ({ cid: a.cid ?? "", mime_type: a.type, content: toBase64(a.content) })) }
          : {}),
      }),
      ZEPTOMAIL_TIMEOUT_MS,
      "ZeptoMail send",
    );
    const requestId =
      response && typeof response === "object" ? (response as { request_id?: string }).request_id : undefined;
    logger.info("Email sent (zeptomail)", { to: recipients, subject: options.subject, requestId });
  } catch (reason) {
    throw zeptoRejectionToError(reason);
  }
}

async function sendWithProvider(
  clients: EmailClients,
  provider: Provider,
  options: EmailOptions,
): Promise<void> {
  if (provider === "zeptomail") {
    await sendViaZeptomail(clients, options);
    return;
  }
  if (provider === "resend") {
    await sendViaResend(clients, options);
    return;
  }
  throw new EmailSendError("No email provider configured", true);
}

@Injectable()
export class EmailProviderService {
  private readonly clients: EmailClients;
  private readonly activeProvider: Provider;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.clients = buildEmailClients(config);
    this.activeProvider = selectProvider(
      config.EMAIL_PROVIDER,
      this.clients.zeptomail !== null,
      this.clients.resend !== null,
    );
  }

  getEmailProvider(): Provider {
    return this.activeProvider;
  }

  async sendEmailOnceDirect(options: EmailOptions, budgetMs?: number): Promise<void> {
  const recipients = normalizeRecipients(options.to);
  if (recipients.length === 0) {
    logger.warn("EMAIL_SKIPPED: no recipients", { subject: options.subject });
    return;
  }
    const send = sendWithProvider(this.clients, this.activeProvider, { ...options, to: recipients });
    if (budgetMs === undefined) {
      await send;
      return;
    }
    await withTimeout(send, budgetMs, "Inline email send");
  }

  async dispatchEmail(options: EmailOptions): Promise<void> {
  const recipients = normalizeRecipients(options.to);
  if (recipients.length === 0) {
    logger.warn("EMAIL_SKIPPED: no recipients", { subject: options.subject });
    return;
  }
  if (this.activeProvider === "none") {
    logger.warn("EMAIL_SKIPPED: no email provider configured", {
      to: recipients,
      subject: options.subject,
      hint: "Set EMAIL_PROVIDER + ZEPTOMAIL_TOKEN (or RESEND_API_KEY) in .env",
    });
    throw new EmailSendError("No email provider configured", true);
  }

  const fallback = fallbackProvider(
    this.activeProvider,
    this.clients.zeptomail !== null,
    this.clients.resend !== null,
  );

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await sendWithProvider(this.clients, this.activeProvider, options);
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientError(error)) {
        if (fallback) {
          logger.warn("Email primary provider rejected send; trying fallback", {
            primary: this.activeProvider,
            fallback,
            to: recipients,
            subject: options.subject,
          });
          try {
            await sendWithProvider(this.clients, fallback, options);
            return;
          } catch (fallbackError) {
            logger.error("Email fallback provider failed", {
              fallback,
              to: recipients,
              subject: options.subject,
              error: fallbackError,
            });
            throw fallbackError;
          }
        }
        logger.error("Email send failed (non-retryable)", {
          provider: this.activeProvider,
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
          provider: this.activeProvider,
          to: recipients,
          subject: options.subject,
          nextRetryMs: backoff,
        });
        await delay(backoff);
      }
    }
  }

  logger.error("Email send failed after all retries", {
    provider: this.activeProvider,
    to: options.to,
    subject: options.subject,
    error: lastError,
  });
  throw lastError;
  }
}
