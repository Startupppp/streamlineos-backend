import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { logSideEffectFailure } from "../../common/logger/side-effect";
import { registerAfterCommit, type AfterCommitHook } from "../../common/tenant/tenant-context";
import { AutomationService, type AutomationTrigger } from "../automation/automation.service";
import { WebhooksDispatchService } from "../webhooks/webhooks-dispatch.service";
import { NotificationsService } from "../notifications/notifications.service";
import { appUrl } from "../email/app-url";
import { organizationMembers } from "../../db/schema";
import type { signEnvelopes } from "../../db/schema";
import { AUTOMATION_TRIGGERS } from "../../db/schema/automation/rules";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";

type SignEnvelopeRow = typeof signEnvelopes.$inferSelect;

export type SignEnvelopeEventKey = "sent" | "completed" | "declined" | "voided" | "expired";

function isAutomationTrigger(value: string): value is AutomationTrigger {
  return AUTOMATION_TRIGGERS.some((trigger) => trigger === value);
}

/**
 * Defer to commit where there is an ambient transaction, otherwise run inline.
 *
 * A bare `void this.something(...)` here kept the request's transaction handle
 * alive past the handler, so the notification INSERT ran against a committed
 * transaction and failed — with no `.catch`, silently (backend/CLAUDE.md §4).
 * `registerAfterCommit` returns `false` outside a request, where running inline
 * is correct.
 */
function afterCommit(task: AfterCommitHook): void {
  if (!registerAfterCommit(task)) void task();
}

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

  private runAutomations(orgId: string, eventName: string, payload: Record<string, unknown>): void {
    if (!isAutomationTrigger(eventName)) return;
    afterCommit(() =>
      this.automation
        .runAutomationsForEvent(orgId, eventName, payload)
        .catch(logSideEffectFailure("sign automations", { orgId, eventName })),
    );
  }

  /** Fire-and-forget: emits to webhooks, automation rules, and the sender's in-app notifications. */
  emitEnvelopeEvent(envelope: SignEnvelopeRow, key: SignEnvelopeEventKey, extra?: Record<string, unknown>): void {
    const eventName = `sign.envelope.${key}`;
    const payload = this.basePayload(envelope, extra);
    const { orgId, id: envelopeId } = envelope;

    this.webhooks.dispatch(orgId, eventName, payload);
    this.runAutomations(orgId, eventName, payload);
    afterCommit(() =>
      this.resolveAndNotifySender(envelope, key).catch(
        logSideEffectFailure("sign sender notification", { orgId, envelopeId, eventName }),
      ),
    );
  }

  emitRecipientCompleted(envelope: SignEnvelopeRow, recipient: { id: number; name: string; email: string | null }): void {
    const eventName = "sign.recipient.completed";
    const payload = this.basePayload(envelope, { recipientId: recipient.id, recipientName: recipient.name, recipientEmail: recipient.email });

    this.webhooks.dispatch(envelope.orgId, eventName, payload);
    this.runAutomations(envelope.orgId, eventName, payload);
  }

  emitBulkSendCompleted(orgId: string, senderUserId: string | null, jobId: number, stats: { totalCount: number; successCount: number; failedCount: number }): void {
    const eventName = "sign.bulk_send.completed";
    const payload: Record<string, unknown> = { jobId, senderUserId, ...stats };

    this.webhooks.dispatch(orgId, eventName, payload);
    this.runAutomations(orgId, eventName, payload);
    if (senderUserId) {
      afterCommit(() =>
        this.notifications
          .create({
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
          })
          .catch(logSideEffectFailure("sign bulk-send notification", { orgId, jobId })),
      );
    }
  }
}
