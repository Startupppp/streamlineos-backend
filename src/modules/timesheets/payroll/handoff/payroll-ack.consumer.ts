import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import {
  OutboxConsumerRegistry,
  outboxEffectIdempotencyKey,
  type OutboxEventConsumer,
  type OutboxEventRow,
} from "../../../../common/outbox/outbox-consumer.registry";
import { TIMESHEET_PAYROLL_HANDOFF_PORT, type TimesheetPayrollHandoffPort } from "./handoff.port";
import {
  TIMESHEET_EVENTS,
  payrollExportAckedEventSchema,
  type PayrollAckPayload,
} from "./handoff.schemas";

const CONSUMER_NAME = "timesheets-payroll-ack";

@Injectable()
export class PayrollAckConsumer implements OutboxEventConsumer, OnModuleInit {
  readonly eventType = TIMESHEET_EVENTS.payrollExportAcked;
  private readonly logger = new Logger(PayrollAckConsumer.name);

  constructor(
    @Inject(TIMESHEET_PAYROLL_HANDOFF_PORT)
    private readonly port: TimesheetPayrollHandoffPort,
    private readonly registry: OutboxConsumerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: OutboxEventRow): Promise<void> {
    const parsed = payrollExportAckedEventSchema.safeParse(event.payload);
    if (!parsed.success) {
      throw new Error(
        `${TIMESHEET_EVENTS.payrollExportAcked} payload does not match its schema: ${parsed.error.message}`,
      );
    }
    const body = parsed.data;

    const payload: PayrollAckPayload = {
      organizationId: event.organizationId,
      exportId: body.export_id,
      status: body.status,
      note: body.note,
      ackAt: body.acked_at,
      ackBy: body.actor_user_id,
      idempotencyKey: outboxEffectIdempotencyKey(event, CONSUMER_NAME),
    };

    await this.port.acknowledged(payload);
    this.logger.debug(`acknowledged payroll export ${body.export_id} as ${body.status}`);
  }
}
