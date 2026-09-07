import { Injectable } from "@nestjs/common";
import type { NotificationChannelProvider } from "./notification-provider.interface";
import type { NotificationChannel, ProviderSendInput, ProviderSendResult, ProviderValidationResult } from "../notification.types";
import { EmailProviderService, isTransientError } from "../../email/email.provider";
import { getEmailTemplate, escapeHtml } from "../../email/templates/base";
import { renderButton } from "../../email/templates/components";
import { createUnsubscribeToken } from "../../email/unsubscribe-token";
import { appUrl } from "../../email/app-url";
import { logger } from "../../../common/logger/logger.service";
import { z } from "zod";

const emailAttachmentsSchema = z.array(
  z.object({ filename: z.string(), contentBase64: z.string(), type: z.string() }),
);

/**
 * COMP-002. RFC 8058 one-click unsubscribe headers, so a mail client can offer the
 * control natively and a recipient never has to hunt for a link.
 *
 * Returned only for non-mandatory events. A payslip or a security alert must not
 * advertise an opt-out that suppression would ignore — offering one and not honouring
 * it is worse than offering none.
 */
function unsubscribeHeaders(input: ProviderSendInput): Record<string, string> | undefined {
  if (input.mandatory) return undefined;
  if (!input.recipientAddress) return undefined;
  const token = createUnsubscribeToken({
    userId: input.userId,
    orgId: input.orgId,
    email: input.recipientAddress,
    scope: "ALL_NON_MANDATORY",
    scopeKey: "",
  });
  if (!token) return undefined;
  const url = `${appUrl()}/notifications/unsubscribe/${token}`;
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

function buildHtml(input: ProviderSendInput): string {
  const emailHtml = typeof input.metadata?.emailHtml === "string" ? input.metadata.emailHtml : undefined;
  if (emailHtml) return emailHtml;
  const title = escapeHtml(input.title);
  const message = escapeHtml(input.message);
  const cta = input.link ? renderButton("Open", input.link) : "";
  const content = `<h1 class="email-title">${title}</h1><p class="email-text">${message}</p>${cta}`;
  return getEmailTemplate({ title: input.title, content });
}

@Injectable()
export class NotificationEmailProvider implements NotificationChannelProvider {
  readonly channel: NotificationChannel = "EMAIL";

  constructor(private readonly emailProvider: EmailProviderService) {}

  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    if (input.sandbox) {
      logger.debug("sandbox email not dispatched", {
        orgId: input.orgId,
        userId: input.userId,
        channel: this.channel,
        hasAddressOnFile: input.recipientAddress != null,
      });
      return { status: "SENT", providerMessageId: "sandbox-email", providerResponse: { sandbox: true } };
    }
    if (!input.recipientAddress) {
      return { status: "FAILED", failureCode: "INVALID_RECIPIENT", failureMessage: "No email address on file", retryable: false };
    }
    if (this.emailProvider.getEmailProvider() === "none") {
      return { status: "FAILED", failureCode: "NO_PROVIDER", failureMessage: "No email provider configured", retryable: false };
    }
    try {
      const parsedAttachments = emailAttachmentsSchema.safeParse(input.metadata?.attachments);
      await this.emailProvider.dispatchEmail({
        to: input.recipientAddress,
        subject: input.title,
        html: buildHtml(input),
        organizationId: input.orgId,
        headers: unsubscribeHeaders(input),
        attachments: parsedAttachments.success
          ? parsedAttachments.data.map((a) => ({
              filename: a.filename,
              content: Buffer.from(a.contentBase64, "base64"),
              type: a.type,
            }))
          : undefined,
      });
      return { status: "SENT", providerResponse: { provider: this.emailProvider.getEmailProvider() } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: "FAILED", failureCode: "PROVIDER_ERROR", failureMessage: message, retryable: isTransientError(error) };
    }
  }

  async validateConfig(): Promise<ProviderValidationResult> {
    const provider = this.emailProvider.getEmailProvider();
    return provider === "none"
      ? { valid: false, message: "No email provider configured (set ZEPTOMAIL_TOKEN or RESEND_API_KEY)" }
      : { valid: true, message: `Email provider: ${provider}` };
  }

  sendTest(input: ProviderSendInput): Promise<ProviderSendResult> {
    return this.send(input);
  }
}
