import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { InboxConsumer } from "../../../common/outbox/inbox-consumer";
import {
  OutboxConsumerRegistry,
  type OutboxEventConsumer,
  type OutboxEventRow,
  outboxEffectIdempotencyKey,
} from "../../../common/outbox/outbox-consumer.registry";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import {
  helpdeskTicketAssignedPayloadSchema,
  helpdeskTicketCreatedPayloadSchema,
  helpdeskTicketStatusChangedPayloadSchema,
} from "./dto/hr-helpdesk-events.schema";
import { AccessService } from "../../access/access.service";
import { SUPPORT_ADMIN_PERMISSION, SUPPORT_QUEUE_LABELS, queuePermissionKey } from "./lib/support-queues";

const CONSUMER_NAME = "hr:helpdesk";

@Injectable()
export class HrHelpdeskEventsConsumer implements OutboxEventConsumer, OnModuleInit {
  readonly eventType = "hr.helpdesk.ticket_created";
  private readonly logger = new Logger(HrHelpdeskEventsConsumer.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly dispatch: NotificationDispatchService,
    private readonly registry: OutboxConsumerRegistry,
    private readonly access: AccessService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.registry.register({ eventType: "hr.helpdesk.ticket_assigned", handle: (e) => this.handle(e) });
    this.registry.register({ eventType: "hr.helpdesk.ticket_status_changed", handle: (e) => this.handle(e) });
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

    if (!claimed) {
      this.logger.debug(`${event.eventType} ${event.eventId} already processed by ${CONSUMER_NAME} — skipping`);
      return;
    }

    try {
      await this.dispatch_(event);
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "COMPLETED", null);
      this.logger.log(`${event.eventType} ${event.eventId}: processed`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`${event.eventType} ${event.eventId}: dispatch failed — ${message}`);
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "FAILED", message);
      throw err;
    }
  }

  private async dispatch_(event: OutboxEventRow): Promise<void> {
    if (event.eventType === "hr.helpdesk.ticket_created") {
      await this.handleTicketCreated(event);
    } else if (event.eventType === "hr.helpdesk.ticket_assigned") {
      await this.handleTicketAssigned(event);
    } else if (event.eventType === "hr.helpdesk.ticket_status_changed") {
      await this.handleTicketStatusChanged(event);
    }
  }

  private async handleTicketCreated(event: OutboxEventRow): Promise<void> {
    const parseResult = helpdeskTicketCreatedPayloadSchema.safeParse(event.payload);
    if (!parseResult.success) {
      throw new Error(`Invalid payload: ${parseResult.error.message}`);
    }
    const { orgId, creatorId, title, category, queue, priority, ticketId, isConfidential } = parseResult.data;

    const [queueMembers, admins] = await Promise.all([
      this.access.membersWithPermission(orgId, queuePermissionKey(queue)),
      this.access.membersWithPermission(orgId, SUPPORT_ADMIN_PERMISSION),
    ]);
    const recipients = new Set([...queueMembers, ...admins].map((member) => member.userId));
    if (recipients.size === 0) return;

    await this.dispatch.emit({
      orgId,
      dedupeKey: outboxEffectIdempotencyKey(event, CONSUMER_NAME),
      eventKey: "hr.helpdesk.ticket_created",
      actorUserId: creatorId,
      targetUserIds: [...recipients],
      entityType: "helpdesk_ticket",
      entityId: String(ticketId),
      title,
      message: `A ${priority} ${isConfidential ? "confidential " : ""}request was raised in the ${SUPPORT_QUEUE_LABELS[queue]} queue (${category}).`,
      link: `/hr/helpdesk?queue=${queue}&ticket=${ticketId}`,
      variables: { ticketId: String(ticketId), title, category, queue, priority, creatorId },
    });
  }

  private async handleTicketAssigned(event: OutboxEventRow): Promise<void> {
    const parseResult = helpdeskTicketAssignedPayloadSchema.safeParse(event.payload);
    if (!parseResult.success) {
      throw new Error(`Invalid payload: ${parseResult.error.message}`);
    }
    const { orgId, actorId, assigneeId, title, ticketId } = parseResult.data;

    await this.dispatch.emit({
      orgId,
      dedupeKey: outboxEffectIdempotencyKey(event, CONSUMER_NAME),
      eventKey: "hr.helpdesk.ticket_assigned",
      actorUserId: actorId,
      targetUserIds: [assigneeId],
      entityType: "helpdesk_ticket",
      entityId: String(ticketId),
      title,
      message: `You have been assigned an employee support request: ${title}.`,
      variables: { ticketId: String(ticketId), title },
    });
  }

  private async handleTicketStatusChanged(event: OutboxEventRow): Promise<void> {
    const parseResult = helpdeskTicketStatusChangedPayloadSchema.safeParse(event.payload);
    if (!parseResult.success) {
      throw new Error(`Invalid payload: ${parseResult.error.message}`);
    }
    const { orgId, actorId, newStatus, title, ownerId, ticketId } = parseResult.data;

    await this.dispatch.emit({
      orgId,
      dedupeKey: outboxEffectIdempotencyKey(event, CONSUMER_NAME),
      eventKey: "hr.helpdesk.ticket_status_changed",
      actorUserId: actorId,
      targetUserIds: [ownerId],
      entityType: "helpdesk_ticket",
      entityId: String(ticketId),
      title,
      message: `Your support request "${title}" has been updated to ${newStatus}.`,
      variables: { ticketId: String(ticketId), title, newStatus },
    });
  }
}
