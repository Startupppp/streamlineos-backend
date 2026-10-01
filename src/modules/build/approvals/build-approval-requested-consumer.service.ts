import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { InboxConsumer } from "../../../common/outbox/inbox-consumer";
import {
  OutboxConsumerRegistry,
  type OutboxEventConsumer,
  type OutboxEventRow,
  outboxEffectIdempotencyKey,
} from "../../../common/outbox/outbox-consumer.registry";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { buildApprovalRequestedPayloadSchema } from "./dto/build-approval-requested-payload.schema";

const CONSUMER_NAME = "build:approval-requested";
export const BUILD_APPROVAL_REQUESTED_EVENT = "build.approval.requested";

@Injectable()
export class BuildApprovalRequestedConsumerService
  implements OutboxEventConsumer, OnModuleInit
{
  readonly eventType = BUILD_APPROVAL_REQUESTED_EVENT;
  private readonly logger = new Logger(
    BuildApprovalRequestedConsumerService.name,
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
        `${BUILD_APPROVAL_REQUESTED_EVENT} ${event.eventId} already processed by ${CONSUMER_NAME} — skipping`,
      );
      return;
    }

    const parseResult = buildApprovalRequestedPayloadSchema.safeParse(
      event.payload,
    );
    if (!parseResult.success) {
      this.logger.warn(
        `${BUILD_APPROVAL_REQUESTED_EVENT} ${event.eventId} has invalid payload: ${parseResult.error.message}`,
      );
      await inbox.markProcessed(
        CONSUMER_NAME,
        event.eventId,
        "FAILED",
        parseResult.error.message,
      );
      return;
    }

    const { approvalId, projectId, approverUserId, title } = parseResult.data;
    const orgId = event.organizationId;
    if (parseResult.data.orgId !== orgId) {
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "FAILED", "payload orgId does not match the event tenant");
      return;
    }

    await this.dispatch.emit({
      orgId,
      dedupeKey: outboxEffectIdempotencyKey(event, CONSUMER_NAME),
      eventKey: BUILD_APPROVAL_REQUESTED_EVENT,
      targetUserIds: [approverUserId],
      entityType: "project_approval",
      entityId: String(approvalId),
      variables: { title, projectId: String(projectId) },
    });

    await inbox.markProcessed(CONSUMER_NAME, event.eventId, "COMPLETED", null);
    this.logger.log(
      `${BUILD_APPROVAL_REQUESTED_EVENT} ${event.eventId}: notified approver of approval ${approvalId}`,
    );
  }
}
