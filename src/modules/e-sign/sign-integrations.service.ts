import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { AutomationService, type AutomationTrigger } from "../automation/automation.service";
import { WebhooksDispatchService } from "../webhooks/webhooks-dispatch.service";
import { NotificationsService } from "../notifications/notifications.service";
import { appUrl } from "../email/app-url";
import { organizationMembers } from "../../db/schema";
import type { signEnvelopes } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";

type SignEnvelopeRow = typeof signEnvelopes.$inferSelect;

export type SignEnvelopeEventKey = "sent" | "completed" | "declined" | "voided" | "expired";

const EVENT_MESSAGES: Record<SignEnvelopeEventKey, (title: string) => string> = {
  sent: (title) => `"${title}" was sent for signature`,
  completed: (title) => `"${title}" has been signed by all parties`,
  declined: (title) => `"${title}" was declined by a signer`,
  voided: (title) => `"${title}" was voided`,
  expired: (title) => `"${title}" expired before completion`,
};

@Injectable()
export class SignIntegrationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly automation: AutomationService,
    private readonly webhooks: WebhooksDispatchService,
    private readonly notifications: NotificationsService,
  ) {}

  private basePayload(envelope: SignEnvelopeRow, extra?: Record<string, unknown>): Record<string, unknown> {
    return {
      envelopeId: envelope.id,
      envelopeTitle: envelope.title,
      status: envelope.status,
      sourceModule: envelope.sourceModule,
      sourceEntityType: envelope.sourceEntityType,
      sourceEntityId: envelope.sourceEntityId,
      senderMembershipId: envelope.senderMembershipId,
      ...extra,
    };
  }

  private async resolveAndNotifySender(envelope: SignEnvelopeRow, key: SignEnvelopeEventKey): Promise<void> {
    if (envelope.senderMembershipId == null) return;
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.orgId, envelope.orgId), eq(organizationMembers.id, envelope.senderMembershipId)),
      with: { user: { columns: { id: true } } },
    });
    if (!member?.user?.id) return;
    const eventName = `sign.envelope.${key}`;
    await this.notifications.create({
      orgId: envelope.orgId,
      userId: member.user.id,
      category: "SIGN",
      sourceModule: envelope.sourceModule ?? "sign",
      eventKey: eventName,
      entityType: envelope.sourceEntityType ?? "envelope",
      entityId: envelope.sourceEntityId ?? String(envelope.id),
      title: "SignOS",
      message: EVENT_MESSAGES[key](envelope.title),
      link: `${appUrl()}/sign/envelopes/${envelope.id}`,
    });
  }

  /** Fire-and-forget: emits to webhooks, automation rules, and the sender's in-app notifications. */
  emitEnvelopeEvent(envelope: SignEnvelopeRow, key: SignEnvelopeEventKey, extra?: Record<string, unknown>): void {
    const eventName = `sign.envelope.${key}`;
    const payload = this.basePayload(envelope, extra);

    this.webhooks.dispatch(envelope.orgId, eventName, payload);
    void this.automation.runAutomationsForEvent(envelope.orgId, eventName as AutomationTrigger, payload);
    void this.resolveAndNotifySender(envelope, key);
  }

  emitRecipientCompleted(envelope: SignEnvelopeRow, recipient: { id: number; name: string; email: string | null }): void {
    const eventName = "sign.recipient.completed";
    const payload = this.basePayload(envelope, { recipientId: recipient.id, recipientName: recipient.name, recipientEmail: recipient.email });

    this.webhooks.dispatch(envelope.orgId, eventName, payload);
    void this.automation.runAutomationsForEvent(envelope.orgId, eventName as AutomationTrigger, payload);
  }

  emitBulkSendCompleted(orgId: string, senderUserId: string | null, jobId: number, stats: { totalCount: number; successCount: number; failedCount: number }): void {
    const eventName = "sign.bulk_send.completed";
    const payload: Record<string, unknown> = { jobId, senderUserId, ...stats };

    this.webhooks.dispatch(orgId, eventName, payload);
    void this.automation.runAutomationsForEvent(orgId, eventName as AutomationTrigger, payload);
    if (senderUserId) {
      void this.notifications.create({
        orgId,
        userId: senderUserId,
        category: "SIGN",
        sourceModule: "sign",
        eventKey: eventName,
        entityType: "bulk_send_job",
        entityId: String(jobId),
        title: "SignOS",
        message: `Bulk send job #${jobId} completed: ${stats.successCount}/${stats.totalCount} sent, ${stats.failedCount} failed`,
        link: `${appUrl()}/sign/bulk-send`,
      });
    }
  }
}
