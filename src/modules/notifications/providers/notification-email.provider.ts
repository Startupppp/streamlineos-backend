import { Inject, Injectable, Logger } from "@nestjs/common";
import { APP_CONFIG } from "../../../config/config.module";
import type { AppConfig } from "../../../config/env.validation";
import type { NotificationChannelProvider } from "./notification-provider.interface";
import type { NotificationChannel, ProviderSendInput, ProviderSendResult, ProviderValidationResult } from "../notification.types";
import { EmailProviderService, isTransientError } from "../../email/email.provider";
import { getEmailTemplate, escapeHtml } from "../../email/templates/base";
import { renderButton } from "../../email/templates/components";
import { createUnsubscribeToken } from "../../email/unsubscribe-token";

/**
 * COMP-002. RFC 8058 one-click unsubscribe headers, so a mail client can offer the
 * control natively and a recipient never has to hunt for a link.
 *
 * Returned only for non-mandatory events. A payslip or a security alert must not
 * advertise an opt-out that suppression would ignore — offering one and not honouring
 * it is worse than offering none.
 *
 * **The URL was built from `appUrl()` and that was wrong.** `APP_URL` is the WEB
 * APP origin — its own comment says so, and every other `appUrl()` caller builds
 * a page there — while `UnsubscribeController` lives on this API at
 * `notifications/unsubscribe/:token`. The web app has no route at that path and
 * no rewrite to here, so the header on every non-mandatory notification email
 * pointed at a 404. Confirmed by looking: no `unsubscribe` segment anywhere
 * under the web app's `app/`, no dynamic segment under its `/notifications`,
 * and no `rewrites` in its Next config.
 *
 * That is worse than sending nothing. One-click is what a mailbox provider tests
 * for on a bulk sender, and a `List-Unsubscribe` that fails is read as a sender
 * refusing to honour opt-outs — so the fix is not to point it somewhere prettier
 * but to send the header ONLY when this API's own public origin is configured.
 * `PUBLIC_API_URL` unset means no header at all, which is honest and is exactly
 * what the rule above already says about mandatory mail.
 */
function unsubscribeHeaders(
  input: ProviderSendInput,
  publicApiUrl: string | undefined,
): Record<string, string> | undefined {
  if (input.mandatory) return undefined;
  if (!input.recipientAddress) return undefined;

  const apiOrigin = publicApiUrl?.trim().replace(/\/$/, "");
  if (!apiOrigin) return undefined;

  const token = createUnsubscribeToken({
    userId: input.userId,
    orgId: input.orgId,
    email: input.recipientAddress,
    scope: "ALL_NON_MANDATORY",
    scopeKey: "",
  });
  if (!token) return undefined;
  const url = `${apiOrigin}/notifications/unsubscribe/${token}`;
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
  private readonly logger = new Logger(NotificationEmailProvider.name);

  constructor(
    private readonly emailProvider: EmailProviderService,
    /**
     * The API's own origin arrives through the config token, not `process.env`.
     *
     * `unsubscribeHeaders` used to read `PUBLIC_API_URL` on every send, from a
     * module-level helper — the same shape `crm/consent/crm-outbound-email`
     * carried until c87a673c3, and this file is the one its comment pointed at
     * as precedent. `no-restricted-syntax` bans it for the reason both files
     * demonstrate: the value is unreachable from a constructor, so the spec had
     * to reach around the object and mutate the environment to describe a
     * deployment.
     *
     * `PUBLIC_API_URL` stays optional on purpose. Unset means the header is
     * omitted entirely rather than pointed at a host that cannot answer it,
     * which is what the comment above spells out.
     */
    @Inject(APP_CONFIG)
    private readonly config: Pick<AppConfig, "PUBLIC_API_URL">,
  ) {}

  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    if (input.sandbox) {
      this.logger.debug(`SANDBOX EMAIL -> ${input.recipientAddress ?? "no-address"}: ${input.title}`);
      return { status: "SENT", providerMessageId: "sandbox-email", providerResponse: { sandbox: true } };
    }
    if (!input.recipientAddress) {
      return { status: "FAILED", failureCode: "INVALID_RECIPIENT", failureMessage: "No email address on file", retryable: false };
    }
    if (this.emailProvider.getEmailProvider() === "none") {
      return { status: "FAILED", failureCode: "NO_PROVIDER", failureMessage: "No email provider configured", retryable: false };
    }
    try {
      await this.emailProvider.dispatchEmail({
        to: input.recipientAddress,
        subject: input.title,
        html: buildHtml(input),
        organizationId: input.orgId,
        headers: unsubscribeHeaders(input, this.config.PUBLIC_API_URL),
        attachments: Array.isArray(input.metadata?.attachments)
          ? (input.metadata.attachments as Array<{ filename: string; contentBase64: string; type: string }>).map((a) => ({
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
