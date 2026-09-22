import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { cycles, organizationMembers, tickets } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { InboxConsumer } from "../../../common/outbox/inbox-consumer";
import {
  OutboxConsumerRegistry,
  type OutboxEventConsumer,
  type OutboxEventRow,
} from "../../../common/outbox/outbox-consumer.registry";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { buildSprintCompletedPayloadSchema } from "./dto/build-sprint-completed-payload.schema";

const CONSUMER_NAME = "build:sprint-completed";

@Injectable()
export class BuildSprintCompletedConsumerService
  implements OutboxEventConsumer, OnModuleInit
{
  readonly eventType = "build.sprint.completed";
  private readonly logger = new Logger(BuildSprintCompletedConsumerService.name);

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
        `build.sprint.completed ${event.eventId} already processed by ${CONSUMER_NAME} — skipping`,
      );
      return;
    }

    const parseResult = buildSprintCompletedPayloadSchema.safeParse(event.payload);
    if (!parseResult.success) {
      this.logger.warn(
        `build.sprint.completed ${event.eventId} has invalid payload: ${parseResult.error.message}`,
      );
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "FAILED", parseResult.error.message);
      return;
    }

    const { sprintId, name } = parseResult.data;
    const orgId = event.organizationId;

    const cycleRows = await this.db
      .select({ id: cycles.id })
      .from(cycles)
      .where(and(eq(cycles.orgId, orgId), eq(cycles.legacySprintId, sprintId)))
      .limit(1);

    if (!cycleRows[0]) {
      this.logger.warn(
        `build.sprint.completed ${event.eventId}: no cycle found for legacy sprint ${sprintId} — skipping`,
      );
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "SKIPPED", "no cycle mapping");
      return;
    }

    const cycleId = cycleRows[0].id;

    const owners = await this.db
      .selectDistinct({ assigneeId: organizationMembers.userId })
      .from(tickets)
      .innerJoin(organizationMembers, and(eq(organizationMembers.orgId, tickets.orgId), eq(organizationMembers.id, tickets.assigneeMembershipId)))
      .where(
        and(
          eq(tickets.orgId, orgId),
          eq(tickets.cycleId, cycleId),
          isNull(tickets.deletedAt),
          isNotNull(tickets.assigneeMembershipId),
        ),
      );

    const targets = owners
      .map((o) => o.assigneeId)
      .filter((id): id is string => Boolean(id));

    if (targets.length === 0) {
      this.logger.debug(
        `build.sprint.completed ${event.eventId}: sprint ${sprintId} has no ticket assignees — skipping`,
      );
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "SKIPPED", "no assignees");
      return;
    }

    await this.dispatch.emit({
      orgId,
      dedupeKey: event.eventId,
      eventKey: "build.sprint.completed",
      targetUserIds: targets,
      entityType: "sprint",
      entityId: String(sprintId),
      variables: { sprintName: name },
    });

    await inbox.markProcessed(CONSUMER_NAME, event.eventId, "COMPLETED", null);
    this.logger.log(
      `build.sprint.completed ${event.eventId}: notified ${targets.length} assignee(s) for sprint ${sprintId}`,
    );
  }
}
