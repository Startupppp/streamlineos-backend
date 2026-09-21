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
