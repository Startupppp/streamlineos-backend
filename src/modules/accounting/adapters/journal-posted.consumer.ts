import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import {
  OutboxConsumerRegistry,
  type OutboxEventConsumer,
  type OutboxEventRow,
} from "../../../common/outbox/outbox-consumer.registry";
import { WebhooksDispatchService } from "../../webhooks/webhooks-dispatch.service";

export const JOURNAL_POSTED_EVENT = "accounting.journal.posted";

/**
 * What `LedgerService.post` writes. Only the two ids this consumer acts on are
 * required; the rest travel to the subscriber exactly as the kernel wrote them.
 */
const journalPostedPayload = z
  .object({
    organization_id: z.string().min(1),
    journal_id: z.string().min(1),
  })
  .passthrough();

/**
 * The registered consumer for `accounting.journal.posted`.
 *
 * The kernel emits this beside every posting, "for other systems to consume".
 * With no consumer registered, `OutboxPublisherService.deliver` throws, and the
 * throw takes the retry and dead-letter path: every journal the ledger posted
 * would have burned its retry budget and landed in the dead-letter queue,
 * in a background sweep nobody watches.
 *
 * "Other systems" means the organisation's own subscribed webhook endpoints,
 * the same shape Timesheets uses for its period lifecycle. `webhook_endpoints`
 * already carries an HMAC secret and an event filter. An organisation with no
 * endpoint subscribed to this event takes the same path: the dispatcher finds
 * nothing and returns.
 *
 * `deliverNow`, not `dispatch`: the publisher already runs this inside the
 * event organisation's tenant transaction and is prepared to retry, so a
 * delivery failure must reach it. The fire-and-forget form would mark the
 * outbox row DELIVERED whatever happened to the webhook.
 */
@Injectable()
export class JournalPostedConsumer implements OutboxEventConsumer, OnModuleInit {
  readonly eventType = JOURNAL_POSTED_EVENT;
  private readonly logger = new Logger(JournalPostedConsumer.name);

  constructor(
    private readonly webhooks: WebhooksDispatchService,
    private readonly registry: OutboxConsumerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: OutboxEventRow): Promise<void> {
    const parsed = journalPostedPayload.safeParse(event.payload);
    if (!parsed.success) {
      throw new Error(`${event.eventType} payload does not match its schema: ${parsed.error.message}`);
    }
    if (parsed.data.organization_id !== event.organizationId) {
      throw new Error(
        `${event.eventType} payload names org ${parsed.data.organization_id} but the outbox row is org ${event.organizationId}`,
      );
    }

    await this.webhooks.deliverNow(event.organizationId, event.eventType, { ...parsed.data });
    this.logger.debug(`${event.eventType} ${parsed.data.journal_id} fanned out to webhooks`);
  }
}
