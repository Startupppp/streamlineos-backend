import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import {
  OutboxConsumerRegistry,
  type OutboxEventConsumer,
  type OutboxEventRow,
} from "../../common/outbox/outbox-consumer.registry";
import { GdprExportWorkerService } from "./gdpr-export-worker.service";
import { GDPR_EXPORT_REQUESTED_EVENT } from "./dto/gdpr-export-outbox.schemas";

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
    this.worker.wake();
    this.logger.debug(
      `${GDPR_EXPORT_REQUESTED_EVENT} ${event.eventId}: woke export worker for org ${event.organizationId}`,
    );
  }
}
