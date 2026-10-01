import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, eq, ne } from "drizzle-orm";
import { organizationMembers, ticketAssignees } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { InboxConsumer } from "../../../../common/outbox/inbox-consumer";
import {
  OutboxConsumerRegistry,
  type OutboxEventConsumer,
  type OutboxEventRow,
  outboxEffectIdempotencyKey,
} from "../../../../common/outbox/outbox-consumer.registry";
import { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import { buildTicketStatusChangedPayloadSchema } from "../dto/build-ticket-status-changed-payload.schema";

const CONSUMER_NAME = "build:ticket-status-changed";

@Injectable()
export class BuildTicketStatusChangedConsumerService
  implements OutboxEventConsumer, OnModuleInit
{
  readonly eventType = "build.ticket.status_changed";
  private readonly logger = new Logger(
    BuildTicketStatusChangedConsumerService.name,
  );

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
    if (!claimed) {
      this.logger.debug(
        `build.ticket.status_changed ${event.eventId} already processed by ${CONSUMER_NAME} — skipping`,
      );
      return;
    }

    const parseResult = buildTicketStatusChangedPayloadSchema.safeParse(
      event.payload,
    );
    if (!parseResult.success) {
      this.logger.warn(
        `build.ticket.status_changed ${event.eventId} has invalid payload: ${parseResult.error.message}`,
      );
      await inbox.markProcessed(
        CONSUMER_NAME,
        event.eventId,
        "FAILED",
        parseResult.error.message,
      );
      return;
    }

    const { ticketId, projectId, newStatus, actorUserId } = parseResult.data;
    const orgId = event.organizationId;
    if (parseResult.data.orgId !== orgId) {
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "FAILED", "payload orgId does not match the event tenant");
      return;
    }

    const assigneeRows = await this.db
      .select({ userId: organizationMembers.userId, membershipId: ticketAssignees.membershipId })
      .from(ticketAssignees)
      .innerJoin(organizationMembers, and(eq(organizationMembers.orgId, ticketAssignees.orgId), eq(organizationMembers.id, ticketAssignees.membershipId)))
      .where(
        and(
          eq(ticketAssignees.orgId, orgId),
          eq(ticketAssignees.ticketId, ticketId),
          ne(organizationMembers.userId, actorUserId),
        ),
      );

    const targets = assigneeRows.map((r) => r.userId);

    if (targets.length === 0) {
      this.logger.debug(
        `build.ticket.status_changed ${event.eventId}: ticket ${ticketId} has no assignees other than actor — skipping`,
      );
      await inbox.markProcessed(
        CONSUMER_NAME,
        event.eventId,
        "SKIPPED",
        "no assignees other than actor",
      );
      return;
    }

    await this.dispatch.emit({
      orgId,
      dedupeKey: outboxEffectIdempotencyKey(event, CONSUMER_NAME),
      eventKey: "build.ticket.status_changed",
      targetUserIds: targets,
      entityType: "ticket",
      entityId: String(ticketId),
      variables: {
        newStatus,
        projectId: String(projectId),
      },
    });

    await inbox.markProcessed(CONSUMER_NAME, event.eventId, "COMPLETED", null);
    this.logger.log(
      `build.ticket.status_changed ${event.eventId}: notified ${targets.length} assignee(s) for ticket ${ticketId}`,
    );
  }
}
