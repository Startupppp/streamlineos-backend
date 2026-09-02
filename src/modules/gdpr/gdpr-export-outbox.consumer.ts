import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import {
  OutboxConsumerRegistry,
  type OutboxEventConsumer,
  type OutboxEventRow,
} from "../../common/outbox/outbox-consumer.registry";
import { GdprExportWorkerService } from "./gdpr-export-worker.service";
import {
  GDPR_EXPORT_REQUESTED_EVENT,
  gdprExportRequestedPayloadSchema,
} from "./dto/gdpr-export-outbox.schemas";

/**
 * Wakes the export worker when a subject requests their data.
 *
 * The payload contract existed and nothing validated with it: `handle` called `wake()` on
 * any row carrying this event type and returned success, so the relay marked the event
 * DELIVERED whatever it contained. Two failures were invisible. A payload the producer had
 * drifted away from still reported delivered while no export ever ran, and a payload whose
 * `orgId` disagreed with the outbox row's `organization_id` — the tenant binding the relay
 * leases and audits on — was waved through rather than being treated as the tenant-binding
 * violation it is.
 *
 * A throw is deliberate for both: it leaves the event to the publisher's retry ladder and
 * finally to the dead-letter the dead-outbox alert reports, so a request that can never run
 * is visible to an operator instead of silently completing. `wake()` is idempotent, so
 * redelivery costs one extra tick.
 */
@Injectable()
export class GdprExportRequestedConsumer implements OutboxEventConsumer, OnModuleInit {
  readonly eventType = GDPR_EXPORT_REQUESTED_EVENT;
  private readonly logger = new Logger(GdprExportRequestedConsumer.name);

  constructor(
    private readonly worker: GdprExportWorkerService,
    private readonly registry: OutboxConsumerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: OutboxEventRow): Promise<void> {
    const parsed = gdprExportRequestedPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      this.logger.error(
        `${GDPR_EXPORT_REQUESTED_EVENT} ${event.eventId}: invalid payload — ${parsed.error.message}`,
      );
      throw new Error(
        `${GDPR_EXPORT_REQUESTED_EVENT} ${event.eventId}: invalid payload`,
      );
    }

    if (parsed.data.orgId !== event.organizationId) {
      this.logger.error(
        `${GDPR_EXPORT_REQUESTED_EVENT} ${event.eventId}: payload orgId does not match the event's organization`,
      );
      throw new Error(
        `${GDPR_EXPORT_REQUESTED_EVENT} ${event.eventId}: payload orgId does not match the event's organization`,
      );
    }

    this.worker.wake();
    this.logger.debug(
      `${GDPR_EXPORT_REQUESTED_EVENT} ${event.eventId}: woke export worker for job ${parsed.data.jobId} in org ${parsed.data.orgId}`,
    );
  }
}
