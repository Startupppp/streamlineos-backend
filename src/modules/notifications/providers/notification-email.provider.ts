import { Injectable, Logger } from "@nestjs/common";
import type { NotificationChannelProvider } from "./notification-provider.interface";
import type { NotificationChannel, ProviderSendInput, ProviderSendResult, ProviderValidationResult } from "../notification.types";
import { dispatchEmail, getEmailProvider, isTransientError } from "../../email/email.provider";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildHtml(input: ProviderSendInput): string {
  const title = escapeHtml(input.title);
  const message = escapeHtml(input.message);
  const cta = input.link
    ? `<p style="margin:24px 0 0"><a href="${escapeHtml(input.link)}" style="background:#0b1220;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-size:14px">Open</a></p>`
    : "";
  return `<div style="font-family:ui-sans-serif,system-ui,sans-serif;max-width:560px;margin:0 auto;color:#0b1220">
    <h2 style="font-size:18px;margin:0 0 8px">${title}</h2>
    <p style="font-size:14px;line-height:1.6;color:#334155;margin:0">${message}</p>
    ${cta}
  </div>`;
}

@Injectable()
export class NotificationEmailProvider implements NotificationChannelProvider {
  readonly channel: NotificationChannel = "EMAIL";
  private readonly logger = new Logger(NotificationEmailProvider.name);

  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    if (input.sandbox) {
      this.logger.debug(`SANDBOX EMAIL -> ${input.recipientAddress ?? "no-address"}: ${input.title}`);
      return { status: "SENT", providerMessageId: "sandbox-email", providerResponse: { sandbox: true } };
    }
    if (!input.recipientAddress) {
      return { status: "FAILED", failureCode: "INVALID_RECIPIENT", failureMessage: "No email address on file", retryable: false };
    }
    if (getEmailProvider() === "none") {
      return { status: "FAILED", failureCode: "NO_PROVIDER", failureMessage: "No email provider configured", retryable: false };
    }
    try {
      await dispatchEmail({ to: input.recipientAddress, subject: input.title, html: buildHtml(input) });
      return { status: "SENT", providerResponse: { provider: getEmailProvider() } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: "FAILED", failureCode: "PROVIDER_ERROR", failureMessage: message, retryable: isTransientError(error) };
    }
  }

  async validateConfig(): Promise<ProviderValidationResult> {
    const provider = getEmailProvider();
    return provider === "none"
      ? { valid: false, message: "No email provider configured (set RESEND_API_KEY or SENDGRID_API_KEY)" }
      : { valid: true, message: `Email provider: ${provider}` };
  }

  sendTest(input: ProviderSendInput): Promise<ProviderSendResult> {
    return this.send(input);
  }
}
