import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { notificationTemplates } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { NotificationChannelProvider } from "./notification-provider.interface";
import type {
  NotificationChannel,
  ProviderSendInput,
  ProviderSendResult,
  ProviderValidationResult,
} from "../notification.types";

/**
 * COMP-005.
 *
 * WhatsApp does not accept arbitrary business-initiated messages: the content must be a
 * template the provider has pre-approved, and sending an unapproved one is rejected —
 * repeatedly, per message, as an opaque provider error, with the account's reputation
 * paying for it.
 *
 * Previously WHATSAPP resolved to the generic sandbox provider, which reports SENT for
 * everything. That is the dangerous shape to leave behind: the day a real provider is
 * wired, the approval gate would have to be remembered rather than already enforced.
 * This provider owns the gate now, so a real transport can be dropped into `transmit`
 * without the compliance rule being re-discovered.
 *
 * An unapproved template fails NON-retryably. Retrying cannot change an approval
 * decision, so a retryable failure would just burn the queue and the provider's
 * goodwill until the job died anyway.
 */
@Injectable()
export class NotificationWhatsAppProvider implements NotificationChannelProvider {
  readonly channel: NotificationChannel = "WHATSAPP";
  private readonly logger = new Logger(NotificationWhatsAppProvider.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    const templateKey = readTemplateKey(input.metadata);

    // No template at all is itself a failure: a business-initiated WhatsApp message
    // without one cannot be delivered, so reporting SENT would be a lie.
    if (!templateKey) {
      return {
        status: "FAILED",
        failureCode: "TEMPLATE_REQUIRED",
        failureMessage:
          "WhatsApp requires an approved message template; this notification declares none.",
        retryable: false,
      };
    }

    const [template] = await this.db
      .select({
        approvalStatus: notificationTemplates.approvalStatus,
        providerTemplateName: notificationTemplates.providerTemplateName,
        rejectionReason: notificationTemplates.approvalRejectionReason,
      })
      .from(notificationTemplates)
      .where(
        and(
          eq(notificationTemplates.orgId, input.orgId),
          eq(notificationTemplates.templateKey, templateKey),
          eq(notificationTemplates.channel, "WHATSAPP"),
          eq(notificationTemplates.isActive, true),
        ),
      )
      .limit(1);

    if (!template) {
      return {
        status: "FAILED",
        failureCode: "TEMPLATE_NOT_FOUND",
        failureMessage: `No active WhatsApp template "${templateKey}" for this organization.`,
        retryable: false,
      };
    }

    if (template.approvalStatus !== "APPROVED") {
      // PENDING is the one case where waiting could help, but the wait is measured in
      // hours or days — far outside the queue's backoff — so it is still terminal here
      // and the template must be re-sent once approval lands.
      return {
        status: "FAILED",
        failureCode: `TEMPLATE_${template.approvalStatus}`,
        failureMessage:
          template.approvalStatus === "REJECTED" && template.rejectionReason
            ? `WhatsApp template "${templateKey}" was rejected: ${template.rejectionReason}`
            : `WhatsApp template "${templateKey}" is not approved (${template.approvalStatus}).`,
        retryable: false,
      };
    }

    if (!template.providerTemplateName) {
      return {
        status: "FAILED",
        failureCode: "TEMPLATE_UNREGISTERED",
        failureMessage: `WhatsApp template "${templateKey}" is approved but carries no provider template name.`,
        retryable: false,
      };
    }

    return this.transmit(input, template.providerTemplateName);
  }

  /**
   * No WhatsApp Business account is connected yet, so this is still simulated. The gate
   * above runs regardless, which is the point: approval is enforced before a transport
   * exists rather than after.
   */
  private async transmit(
    input: ProviderSendInput,
    providerTemplateName: string,
  ): Promise<ProviderSendResult> {
    this.logger.debug(
      `SANDBOX WHATSAPP -> user ${input.userId} via approved template ${providerTemplateName}`,
    );
    return {
      status: "SENT",
      providerMessageId: `sandbox-whatsapp-${input.userId}`,
      providerResponse: { sandbox: true, channel: "WHATSAPP", providerTemplateName },
      costAmount: 0,
      costCurrency: "USD",
    };
  }

  async validateConfig(): Promise<ProviderValidationResult> {
    return {
      valid: true,
      message: "WhatsApp runs in sandbox; template approval is still enforced.",
    };
  }

  sendTest(input: ProviderSendInput): Promise<ProviderSendResult> {
    return this.send(input);
  }
}

function readTemplateKey(metadata: Record<string, unknown> | undefined): string | null {
  const value = metadata?.templateKey;
  return typeof value === "string" && value.length > 0 ? value : null;
}
