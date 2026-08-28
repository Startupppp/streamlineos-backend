import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { InboxConsumer } from "../../common/outbox/inbox-consumer";
import {
  OutboxConsumerRegistry,
  outboxEffectIdempotencyKey,
  type OutboxEventConsumer,
  type OutboxEventRow,
} from "../../common/outbox/outbox-consumer.registry";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { AutomationService } from "../automation/automation.service";
import { AccessService } from "../access/access.service";
import {
  EXPENSE_DECIDED_EVENT,
  EXPENSE_SUBMITTED_EVENT,
  decisionEventKey,
  expenseDecidedPayloadSchema,
  expenseSubmittedPayloadSchema,
} from "./dto/expense-outbox.schemas";

const SUBMITTED_CONSUMER = "expenses:submitted";
const DECIDED_CONSUMER = "expenses:decided";

const EXPENSE_APPROVE_PERMISSION = "hr:expenses:approve";

@Injectable()
export class ExpenseSubmittedConsumer implements OutboxEventConsumer, OnModuleInit {
  readonly eventType = EXPENSE_SUBMITTED_EVENT;
  private readonly logger = new Logger(ExpenseSubmittedConsumer.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly dispatch: NotificationDispatchService,
    private readonly automation: AutomationService,
    private readonly access: AccessService,
    private readonly registry: OutboxConsumerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: OutboxEventRow): Promise<void> {
    const inbox = new InboxConsumer(this.db);
    const claimed = await inbox.claim(SUBMITTED_CONSUMER, {
      eventId: event.eventId,
      organizationId: event.organizationId,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      aggregateVersion: event.aggregateVersion,
    });
    if (!claimed) return;

    const parsed = expenseSubmittedPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      await inbox.markProcessed(SUBMITTED_CONSUMER, event.eventId, "FAILED", parsed.error.message);
      return;
    }
    if (parsed.data.orgId !== event.organizationId) {
      await inbox.markProcessed(
        SUBMITTED_CONSUMER,
        event.eventId,
        "FAILED",
        "expense payload organization does not match the outbox event",
      );
      return;
    }

    const payload = parsed.data;
    const orgId = event.organizationId;
    const actorName = await this.resolveActorName(payload.actorUserId);

    if (payload.runAutomations) {
      await this.automation.runAutomationsForEvent(orgId, "expense.submitted", {
        expenseId: payload.expenseId,
        userId: payload.actorUserId,
        employeeName: actorName ?? "",
        amount: payload.amount,
        category: payload.category,
        submittedAt: event.occurredAt.toISOString(),
      });
    }

    const targetUserIds = await this.resolveRecipients(orgId, payload.recipients);
    if (targetUserIds.length === 0) {
      await inbox.markProcessed(SUBMITTED_CONSUMER, event.eventId, "SKIPPED", "no approver recipients");
      return;
    }

    try {
      await this.dispatch.emit({
        eventKey: "accounting.expense.submitted",
        orgId,
        actorUserId: payload.actorUserId,
        targetUserIds,
        dedupeKey: outboxEffectIdempotencyKey(event, SUBMITTED_CONSUMER),
        entityType: "expense",
        entityId: String(payload.expenseId),
        variables: {
          employeeName: actorName ?? "Employee",
          amount: payload.amount,
          category: payload.category,
          description: payload.description ?? "",
        },
      });
    } catch (error: unknown) {
      await inbox.markProcessed(
        SUBMITTED_CONSUMER,
        event.eventId,
        "FAILED",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }

    await inbox.markProcessed(SUBMITTED_CONSUMER, event.eventId, "COMPLETED");
    this.logger.log(
      `${EXPENSE_SUBMITTED_EVENT} ${event.eventId}: notified ${targetUserIds.length} approver(s) for expense ${payload.expenseId}`,
    );
  }

  private async resolveRecipients(
    orgId: string,
    recipients: { mode: "EXPLICIT"; userIds: string[] } | { mode: "EXPENSE_APPROVERS" },
  ): Promise<string[]> {
    if (recipients.mode === "EXPLICIT") return recipients.userIds;
    const approvers = await this.access.membersWithPermission(orgId, EXPENSE_APPROVE_PERMISSION);
    return approvers.map((approver) => approver.userId);
  }

  private async resolveActorName(userId: string): Promise<string | null> {
    const actor = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { name: true },
    });
    return actor?.name ?? null;
  }
}

@Injectable()
export class ExpenseDecidedConsumer implements OutboxEventConsumer, OnModuleInit {
  readonly eventType = EXPENSE_DECIDED_EVENT;
  private readonly logger = new Logger(ExpenseDecidedConsumer.name);

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
    const claimed = await inbox.claim(DECIDED_CONSUMER, {
      eventId: event.eventId,
      organizationId: event.organizationId,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      aggregateVersion: event.aggregateVersion,
    });
    if (!claimed) return;

    const parsed = expenseDecidedPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      await inbox.markProcessed(DECIDED_CONSUMER, event.eventId, "FAILED", parsed.error.message);
      return;
    }
    if (parsed.data.orgId !== event.organizationId) {
      await inbox.markProcessed(
        DECIDED_CONSUMER,
        event.eventId,
        "FAILED",
        "expense payload organization does not match the outbox event",
      );
      return;
    }

    const payload = parsed.data;

    try {
      await this.dispatch.emit({
        eventKey: decisionEventKey(payload.status),
        orgId: event.organizationId,
        actorUserId: payload.actorUserId,
        targetUserIds: [payload.recipientUserId],
        dedupeKey: outboxEffectIdempotencyKey(event, DECIDED_CONSUMER),
        entityType: "expense",
        entityId: String(payload.expenseId),
        variables: {
          amount: payload.amount,
          category: payload.category,
          rejectionReason: payload.rejectionReason,
          reason: payload.rejectionReason,
          journalEntryId: payload.journalEntryId,
        },
      });
    } catch (error: unknown) {
      await inbox.markProcessed(
        DECIDED_CONSUMER,
        event.eventId,
        "FAILED",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }

    await inbox.markProcessed(DECIDED_CONSUMER, event.eventId, "COMPLETED");
    this.logger.log(
      `${EXPENSE_DECIDED_EVENT} ${event.eventId}: notified submitter of expense ${payload.expenseId} (${payload.status})`,
    );
  }
}
