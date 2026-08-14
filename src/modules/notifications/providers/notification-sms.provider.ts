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
 * COMP-004, software half.
 *
 * Registering with the Indian DLT (Distributed Ledger Technology) registry is a human,
 * out-of-band process: a business entity is registered with an operator, headers/sender
 * IDs are approved, and each template is approved individually. Nothing in this codebase
 * can perform that, and nothing here claims to.
 *
 * What IS the software's responsibility is refusing to send content DLT has not approved.
 * Without this, an unregistered template is discovered as an opaque operator rejection,
 * per message, and repeated rejections put the sender ID's registration at risk.
 *
 * SMS previously resolved to the generic sandbox provider, which reports SENT for
 * everything — so the gate would have had to be remembered at the moment a real operator
 * was wired in. It is enforced now instead. The approval columns are shared with
 * WhatsApp (COMP-005): `providerTemplateName` holds the DLT template id.
 */
@Injectable()
export class NotificationSmsProvider implements NotificationChannelProvider {
  readonly channel: NotificationChannel = "SMS";
  private readonly logger = new Logger(NotificationSmsProvider.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    const templateKey = readTemplateKey(input.metadata);

    // Transactional SMS in India must map to a registered template. A send with no
    // template cannot be attributed to one, so it cannot go out.
    if (!templateKey) {
      return {
        status: "FAILED",
        failureCode: "DLT_TEMPLATE_REQUIRED",
        failureMessage:
          "SMS requires a DLT-registered template; this notification declares none.",
        retryable: false,
      };
    }

    const [template] = await this.db
      .select({
        approvalStatus: notificationTemplates.approvalStatus,
        dltTemplateId: notificationTemplates.providerTemplateName,
        rejectionReason: notificationTemplates.approvalRejectionReason,
      })
      .from(notificationTemplates)
      .where(
        and(
          eq(notificationTemplates.orgId, input.orgId),
          eq(notificationTemplates.templateKey, templateKey),
          eq(notificationTemplates.channel, "SMS"),
          eq(notificationTemplates.isActive, true),
        ),
      )
      .limit(1);

    if (!template) {
      return {
        status: "FAILED",
        failureCode: "DLT_TEMPLATE_NOT_FOUND",
        failureMessage: `No active SMS template "${templateKey}" for this organization.`,
        retryable: false,
      };
    }

    // Retrying cannot change a registration decision, and repeated rejected sends count
    // against the sender ID — so every one of these is terminal, not backed off.
    if (template.approvalStatus !== "APPROVED") {
      return {
        status: "FAILED",
        failureCode: `DLT_TEMPLATE_${template.approvalStatus}`,
        failureMessage:
          template.approvalStatus === "REJECTED" && template.rejectionReason
            ? `DLT registration for "${templateKey}" was rejected: ${template.rejectionReason}`
            : `SMS template "${templateKey}" is not DLT-approved (${template.approvalStatus}).`,
        retryable: false,
      };
    }

    if (!template.dltTemplateId) {
      return {
        status: "FAILED",
        failureCode: "DLT_TEMPLATE_UNREGISTERED",
        failureMessage: `SMS template "${templateKey}" is approved but carries no DLT template id.`,
        retryable: false,
      };
    }

    return this.transmit(input, template.dltTemplateId);
  }

  /**
   * No operator is connected, so this is simulated — deliberately behind the gate rather
   * than instead of it. Wiring a real operator means replacing this method only.
   */
  private async transmit(
    input: ProviderSendInput,
    dltTemplateId: string,
  ): Promise<ProviderSendResult> {
    this.logger.debug(
      `SANDBOX SMS -> user ${input.userId} via DLT template ${dltTemplateId}`,
    );
    return {
      status: "SENT",
      providerMessageId: `sandbox-sms-${input.userId}`,
      providerResponse: { sandbox: true, channel: "SMS", dltTemplateId },
      costAmount: 0,
      costCurrency: "INR",
    };
  }

  async validateConfig(): Promise<ProviderValidationResult> {
    return {
      valid: true,
      message: "SMS runs in sandbox; DLT template approval is still enforced.",
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
