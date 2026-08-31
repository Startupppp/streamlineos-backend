import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { OutboxConsumerRegistry, type OutboxEventConsumer, type OutboxEventRow } from "../../../common/outbox/outbox-consumer.registry";
import { FINANCE_REPORT_EXPORT_REQUESTED_EVENT } from "./dto/finance-report-export.schemas";
import { FinanceReportExportWorkerService } from "./finance-report-export-worker.service";

@Injectable()
export class FinanceReportExportRequestedConsumer implements OutboxEventConsumer, OnModuleInit {
  readonly eventType = FINANCE_REPORT_EXPORT_REQUESTED_EVENT;
  private readonly logger = new Logger(FinanceReportExportRequestedConsumer.name);

  constructor(private readonly worker: FinanceReportExportWorkerService, private readonly registry: OutboxConsumerRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: OutboxEventRow): Promise<void> {
    this.worker.wake();
    this.logger.debug(`${FINANCE_REPORT_EXPORT_REQUESTED_EVENT} ${event.eventId}: woke finance report export worker for org ${event.organizationId}`);
  }
}
