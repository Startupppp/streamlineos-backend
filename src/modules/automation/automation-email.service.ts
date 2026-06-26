import { Injectable } from "@nestjs/common";
import { Resend } from "resend";
import sgMail from "@sendgrid/mail";
import { logger } from "../../common/logger/logger.service";

export interface AutomationEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
}

type Provider = "resend" | "sendgrid" | "none";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const DEFAULT_FROM = "no-reply@streamlineos.app";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

function isTransientError(error: unknown): boolean {
  if (!error || typeof error !== "object") return true;
  const code = (error as { code?: number | string }).code;
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return true;
  }
  const statusCode =
    (error as { statusCode?: number }).statusCode ?? (typeof code === "number" ? code : undefined);
  if (typeof statusCode === "number") {
    if (statusCode >= 500 && statusCode < 600) return true;
    if (statusCode >= 400 && statusCode < 500) return false;
  }
  return true;
}

function normalizeRecipients(to: string | string[]): string[] {
  const arr = Array.isArray(to) ? to : [to];
  return arr.map((value) => value.trim()).filter(Boolean);
}

@Injectable()
export class AutomationEmailService {
  private readonly resend: Resend | null;
  private readonly provider: Provider;

  constructor() {
    const resendKey = process.env.RESEND_API_KEY;
    const sendgridKey = process.env.SENDGRID_API_KEY;
    const preference = process.env.EMAIL_PROVIDER?.toLowerCase().trim();

    this.resend = resendKey ? new Resend(resendKey) : null;
    if (sendgridKey) sgMail.setApiKey(sendgridKey);

    if (preference === "sendgrid" && sendgridKey) this.provider = "sendgrid";
    else if (preference === "resend" && this.resend) this.provider = "resend";
    else if (this.resend) this.provider = "resend";
    else if (sendgridKey) this.provider = "sendgrid";
    else this.provider = "none";
  }

  getProvider(): Provider {
    return this.provider;
  }

  private fromAddress(): string {
    const name = process.env.EMAIL_FROM_NAME?.trim();
    const email = process.env.EMAIL_FROM_ADDRESS?.trim();
    const from = email && EMAIL_RE.test(email) ? email : DEFAULT_FROM;
    return name ? `${name} <${from}>` : from;
  }

  private async sendViaResend(options: AutomationEmailOptions, recipients: string[]): Promise<void> {
    if (!this.resend) throw new Error("Resend not initialized");
    const { data, error } = await this.resend.emails.send({
      from: this.fromAddress(),
      to: recipients,
      subject: options.subject,
      html: options.html,
      text: options.text || htmlToText(options.html),
    });
    if (error) {
      throw new Error(error.message || "Resend send failed");
    }
    logger.info("automation.email sent (resend)", { to: recipients, subject: options.subject, id: data?.id });
  }

  private async sendViaSendgrid(options: AutomationEmailOptions, recipients: string[]): Promise<void> {
    const msg: sgMail.MailDataRequired = {
      to: recipients.length === 1 ? recipients[0] : recipients,
      from: this.fromAddress(),
      subject: options.subject,
      html: options.html,
      text: options.text || htmlToText(options.html),
    };
    await sgMail.send(msg);
    logger.info("automation.email sent (sendgrid)", { to: recipients, subject: options.subject });
  }

  async send(options: AutomationEmailOptions): Promise<void> {
    const recipients = normalizeRecipients(options.to);
    if (recipients.length === 0) {
      logger.warn("automation.email skipped: no recipients", { subject: options.subject });
      return;
    }
    if (this.provider === "none") {
      logger.warn("automation.email skipped: no provider configured", {
        to: recipients,
        subject: options.subject,
        hint: "Set EMAIL_PROVIDER + RESEND_API_KEY (or SENDGRID_API_KEY) in .env",
      });
      return;
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (this.provider === "resend") await this.sendViaResend(options, recipients);
        else await this.sendViaSendgrid(options, recipients);
        return;
      } catch (error) {
        lastError = error;
        if (!isTransientError(error)) {
          logger.error("automation.email failed (non-retryable)", {
            provider: this.provider,
            to: recipients,
            subject: options.subject,
            attempt,
          });
          throw error;
        }
        if (attempt < MAX_RETRIES) {
          await delay(BASE_DELAY_MS * Math.pow(2, attempt - 1));
        }
      }
    }

    logger.error("automation.email failed after retries", {
      provider: this.provider,
      to: recipients,
      subject: options.subject,
    });
    throw lastError;
  }
}
