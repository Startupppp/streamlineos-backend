import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import {
  OutboxConsumerRegistry,
  outboxEffectIdempotencyKey,
  type OutboxEventConsumer,
  type OutboxEventRow,
} from "../../../../common/outbox/outbox-consumer.registry";
import { ExternalEffectLedger } from "../../../../common/outbox/external-effect-ledger";
import { WebhooksDispatchService } from "../../../webhooks/webhooks-dispatch.service";
import {
  TIMESHEET_LIFECYCLE_EVENT_TYPES,
  periodLifecycleEventSchema,
} from "./timesheet-lifecycle.events";

/**
 * TS-06. The registered consumer for every timesheet period lifecycle event.
 *
 * This is not bookkeeping. `OutboxPublisherService.deliver` throws on an event
 * type with no registered consumer, and that throw goes down the retry and
 * dead-letter path — so shipping the emits of TS-05 without this class would
 * dead-letter every submit, approval, rejection and lock in the platform, eight
 * retries apiece, in a background sweep where nobody would see it. "No
 * dead-letter on emit" is the acceptance line for this ticket and it is this
 * file that satisfies it.
 *
 * What it does with the event is fan it out to the organisation's own
 * subscribed webhook endpoints. That is a real registration rather than the
 * documented null the ticket also permits: `webhook_endpoints` already exists,
 * already carries an HMAC secret and an event filter, and a lifecycle event
 * that no external system can subscribe to is not much of a lifecycle event.
 * An organisation with no matching endpoint is served by the same path — the
 * dispatcher finds nothing subscribed and returns.
 *
 * One class, four registrations. `OutboxEventConsumer` is a structural
 * interface with a single `eventType`, so a class per event would be four
 * copies of one method; instead the registry receives a small adapter per type
 * that delegates here.
 */
@Injectable()
export class TimesheetLifecycleConsumer implements OnModuleInit {
  private readonly logger = new Logger(TimesheetLifecycleConsumer.name);

  private static readonly CONSUMER_NAME = "timesheets:lifecycle:webhook-delivery";

  constructor(
    private readonly webhooks: WebhooksDispatchService,
    private readonly registry: OutboxConsumerRegistry,
    private readonly effects: ExternalEffectLedger,
  ) {}

  onModuleInit(): void {
    for (const eventType of TIMESHEET_LIFECYCLE_EVENT_TYPES) {
      const consumer: OutboxEventConsumer = {
        eventType,
        handle: (event) => this.handle(event),
      };
      this.registry.register(consumer);
    }
  }

  /**
   * `deliverNow`, not `dispatch`.
   *
   * The publisher already wraps this in the event organisation's own tenant
   * transaction, and it is prepared to retry — so a delivery failure should
   * reach it rather than be logged and swallowed. `dispatch` is the
   * fire-and-forget form built for a request handler that has already
   * returned; using it here would mark the outbox row DELIVERED no matter what
   * happened to the webhook.
   */
  async handle(event: OutboxEventRow): Promise<void> {
    const parsed = periodLifecycleEventSchema.safeParse(event.payload);
    if (!parsed.success) {
      throw new Error(
        `${event.eventType} payload does not match its schema: ${parsed.error.message}`,
      );
    }
    if (parsed.data.organization_id !== event.organizationId) {
      throw new Error(
        `${event.eventType} payload names org ${parsed.data.organization_id} but the outbox row is org ${event.organizationId}`,
      );
    }

    await this.effects.execute(
      {
        organizationId: event.organizationId,
        producerEventId: event.eventId,
        effectKey: outboxEffectIdempotencyKey(event, TimesheetLifecycleConsumer.CONSUMER_NAME),
        effectType: "webhook.delivery",
        providerIdempotency: "NONE",
      },
      () => this.webhooks.deliverNow(event.organizationId, event.eventType, { ...parsed.data }),
    );
    this.logger.debug(
      `fanned ${event.eventType} for period ${parsed.data.period_id} to subscribed endpoints`,
    );
  }
}
