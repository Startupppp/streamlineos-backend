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
import { buildBlockerCreatedPayloadSchema } from "../dto/build-blocker-created-payload.schema";

const CONSUMER_NAME = "build:blocker-created";
export const BUILD_BLOCKER_CREATED_EVENT = "build.blocker.created";

@Injectable()
export class BuildBlockerCreatedConsumerService
  implements OutboxEventConsumer, OnModuleInit
{
  readonly eventType = BUILD_BLOCKER_CREATED_EVENT;
  private readonly logger = new Logger(BuildBlockerCreatedConsumerService.name);

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
        `${BUILD_BLOCKER_CREATED_EVENT} ${event.eventId} already processed by ${CONSUMER_NAME} — skipping`,
      );
      return;
    }

    const parseResult = buildBlockerCreatedPayloadSchema.safeParse(event.payload);
    if (!parseResult.success) {
      this.logger.warn(
        `${BUILD_BLOCKER_CREATED_EVENT} ${event.eventId} has invalid payload: ${parseResult.error.message}`,
      );
      await inbox.markProcessed(
        CONSUMER_NAME,
        event.eventId,
        "FAILED",
        parseResult.error.message,
      );
      return;
    }

    const { blockedTicketId, blockingTicketId, projectId, orgId, actorUserId } =
      parseResult.data;

    const assigneeRows = await this.db
      .select({ userId: organizationMembers.userId })
      .from(ticketAssignees)
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.orgId, ticketAssignees.orgId),
          eq(organizationMembers.id, ticketAssignees.membershipId),
        ),
      )
      .where(
        and(
          eq(ticketAssignees.orgId, orgId),
          eq(ticketAssignees.ticketId, blockedTicketId),
          ne(organizationMembers.userId, actorUserId),
        ),
      );

    const targets = assigneeRows.map((row) => row.userId);

    if (targets.length === 0) {
      this.logger.debug(
        `${BUILD_BLOCKER_CREATED_EVENT} ${event.eventId}: ticket ${blockedTicketId} has no assignees other than actor — skipping`,
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
      eventKey: BUILD_BLOCKER_CREATED_EVENT,
      targetUserIds: targets,
      entityType: "ticket",
      entityId: String(blockedTicketId),
      variables: {
        blockingTicketId: String(blockingTicketId),
        projectId: String(projectId),
      },
    });

    await inbox.markProcessed(CONSUMER_NAME, event.eventId, "COMPLETED", null);
    this.logger.log(
      `${BUILD_BLOCKER_CREATED_EVENT} ${event.eventId}: notified ${targets.length} assignee(s) that ticket ${blockedTicketId} is blocked by ${blockingTicketId}`,
    );
  }
}
