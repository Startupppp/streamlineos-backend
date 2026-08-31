import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { signEnvelopes } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { InboxConsumer } from "../../common/outbox/inbox-consumer";
import {
  OutboxConsumerRegistry,
  type OutboxEventConsumer,
  type OutboxEventRow,
  outboxEffectIdempotencyKey,
} from "../../common/outbox/outbox-consumer.registry";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";

const payloadSchema = z.object({
  envelopeId: z.number().int(),
  orgId: z.string(),
});

const CONSUMER_NAME = "sign:envelope-completed";

@Injectable()
export class SignEnvelopeCompletedConsumerService
  implements OutboxEventConsumer, OnModuleInit
{
  readonly eventType = "sign.envelope.completed";
  private readonly logger = new Logger(SignEnvelopeCompletedConsumerService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly registry: OutboxConsumerRegistry,
    private readonly dispatch: NotificationDispatchService,
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
        `sign.envelope.completed ${event.eventId} already processed by ${CONSUMER_NAME} — skipping`,
      );
      return;
    }

    const parseResult = payloadSchema.safeParse(event.payload);
    if (!parseResult.success) {
      this.logger.warn(
        `sign.envelope.completed ${event.eventId} has invalid payload: ${parseResult.error.message}`,
      );
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "FAILED", parseResult.error.message);
      return;
    }

    const { envelopeId } = parseResult.data;
    const orgId = event.organizationId;

    const envelope = await this.db.query.signEnvelopes.findFirst({
      where: eq(signEnvelopes.id, envelopeId),
      columns: { senderUserId: true, title: true },
    });

    if (!envelope) {
      this.logger.debug(
        `sign.envelope.completed ${event.eventId}: envelope ${envelopeId} not found — skipping`,
      );
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "SKIPPED", "envelope not found");
      return;
    }

    await this.dispatch.emit({
      orgId,
      dedupeKey: outboxEffectIdempotencyKey(event, CONSUMER_NAME),
      eventKey: "sign.document.completed",
      targetUserIds: [envelope.senderUserId],
      entityType: "sign_envelope",
      entityId: String(envelopeId),
      variables: { title: envelope.title },
    });

    await inbox.markProcessed(CONSUMER_NAME, event.eventId, "COMPLETED", null);
    this.logger.log(
      `sign.envelope.completed ${event.eventId}: notified sender ${envelope.senderUserId} for envelope ${envelopeId}`,
    );
  }
}
