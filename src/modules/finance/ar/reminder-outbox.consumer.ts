import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { finReminderLog, organizationMembers } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { InboxConsumer } from "../../../common/outbox/inbox-consumer";
import {
  OutboxConsumerRegistry,
  outboxEffectIdempotencyKey,
  type OutboxEventConsumer,
  type OutboxEventRow,
} from "../../../common/outbox/outbox-consumer.registry";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { INVOICE_REMINDER_EVENT, invoiceReminderPayloadSchema } from "./dto/reminder-outbox.schemas";

const CONSUMER_NAME = "finance:invoice-reminder";

@Injectable()
export class ReminderOutboxConsumer implements OutboxEventConsumer, OnModuleInit {
  readonly eventType = INVOICE_REMINDER_EVENT;
  private readonly logger = new Logger(ReminderOutboxConsumer.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly dispatch: NotificationDispatchService,
    private readonly registry: OutboxConsumerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: OutboxEventRow): Promise<void> {
    const inbox = new InboxConsumer(this.db);
    const claimed = await inbox.claim(CONSUMER_NAME, {
      eventId: event.eventId,
      organizationId: event.organizationId,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      aggregateVersion: event.aggregateVersion,
    });
    if (!claimed) return;

    const parsed = invoiceReminderPayloadSchema.safeParse(event.payload);
    if (!parsed.success || parsed.data.orgId !== event.organizationId) {
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "SKIPPED", "invalid reminder payload");
      return;
    }

    const payload = parsed.data;
    const activeRecipients = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, event.organizationId),
          eq(organizationMembers.status, "ACTIVE"),
          inArray(organizationMembers.userId, payload.targetUserIds),
        ),
      );
    const targetUserIds = activeRecipients.map((recipient) => recipient.userId);
    if (targetUserIds.length === 0) {
      await this.db
        .update(finReminderLog)
        .set({ status: "SKIPPED" })
        .where(and(eq(finReminderLog.orgId, event.organizationId), eq(finReminderLog.id, payload.reminderLogId)));
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "SKIPPED", "no active recipients");
      return;
    }
    try {
      await this.dispatch.emit({
        eventKey: "accounting.invoice.overdue",
        orgId: event.organizationId,
        targetUserIds,
        dedupeKey: outboxEffectIdempotencyKey(event, CONSUMER_NAME),
        entityType: "invoice",
        entityId: String(payload.invoiceId),
        title: "Invoice payment reminder",
        message: `Reminder: Invoice ${payload.invoiceNumber} ${payload.offsetDays >= 0 ? `is due in ${payload.offsetDays} days` : `was due ${Math.abs(payload.offsetDays)} days ago`}`,
      });
      await this.db
        .update(finReminderLog)
        .set({ status: "SENT", sentAt: new Date() })
        .where(and(eq(finReminderLog.orgId, event.organizationId), eq(finReminderLog.id, payload.reminderLogId)));
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "COMPLETED");
    } catch (error: unknown) {
      await this.db
        .update(finReminderLog)
        .set({ status: "FAILED" })
        .where(and(eq(finReminderLog.orgId, event.organizationId), eq(finReminderLog.id, payload.reminderLogId)));
      const errMsg = typeof error === "object" && error !== null && "message" in error
        ? String((error as { message: unknown }).message)
        : String(error);
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "FAILED", errMsg);
      this.logger.error(`invoice reminder ${event.eventId} failed`, errMsg);
      throw error;
    }
  }
}
