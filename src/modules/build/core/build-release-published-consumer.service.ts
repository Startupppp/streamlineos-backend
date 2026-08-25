import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { releaseTickets, tickets } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { InboxConsumer } from "../../../common/outbox/inbox-consumer";
import {
  OutboxConsumerRegistry,
  type OutboxEventConsumer,
  type OutboxEventRow,
} from "../../../common/outbox/outbox-consumer.registry";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { buildReleasePublishedPayloadSchema } from "./dto/build-release-published-payload.schema";

const CONSUMER_NAME = "build:release-published";

@Injectable()
export class BuildReleasePublishedConsumerService
  implements OutboxEventConsumer, OnModuleInit
{
  readonly eventType = "build.release.published";
  private readonly logger = new Logger(BuildReleasePublishedConsumerService.name);

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
        `build.release.published ${event.eventId} already processed by ${CONSUMER_NAME} — skipping`,
      );
      return;
    }

    const parseResult = buildReleasePublishedPayloadSchema.safeParse(event.payload);
    if (!parseResult.success) {
      this.logger.warn(
        `build.release.published ${event.eventId} has invalid payload: ${parseResult.error.message}`,
      );
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "FAILED", parseResult.error.message);
      return;
    }

    const { releaseId, name, version } = parseResult.data;
    const orgId = event.organizationId;

    // FK-determined audience: releaseTickets links tickets to a release, and each
    // ticket carries an assigneeId. Every assignee of a ticket in the release is
    // notified — the same derivation used by the sprint.ending sweep, applied here
    // through the release→ticket FK rather than the sprint→ticket FK.
    const owners = await this.db
      .selectDistinct({ assigneeId: tickets.assigneeId })
      .from(releaseTickets)
      .innerJoin(
        tickets,
        and(
          eq(tickets.id, releaseTickets.ticketId),
          eq(tickets.orgId, orgId),
        ),
      )
      .where(
        and(
          eq(releaseTickets.orgId, orgId),
          eq(releaseTickets.releaseId, releaseId),
          isNull(tickets.deletedAt),
          isNotNull(tickets.assigneeId),
        ),
      );

    const targets = owners
      .map((o) => o.assigneeId)
      .filter((id): id is string => Boolean(id));

    if (targets.length === 0) {
      this.logger.debug(
        `build.release.published ${event.eventId}: release ${releaseId} has no ticket assignees — skipping`,
      );
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "SKIPPED", "no ticket assignees");
      return;
    }

    await this.dispatch.emit({
      orgId,
      dedupeKey: event.eventId,
      eventKey: "build.release.published",
      targetUserIds: targets,
      entityType: "release",
      entityId: String(releaseId),
      variables: { releaseName: name, version: version ?? "" },
    });

    await inbox.markProcessed(CONSUMER_NAME, event.eventId, "COMPLETED", null);
    this.logger.log(
      `build.release.published ${event.eventId}: notified ${targets.length} assignee(s) for release ${releaseId}`,
    );
  }
}
