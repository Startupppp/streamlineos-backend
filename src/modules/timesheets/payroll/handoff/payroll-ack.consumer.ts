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

/**
 * Turns a recorded acknowledgement into a call on the handoff port.
 *
 * Unlike the export consumer this reads nothing back: everything an
 * acknowledgement means is in the event itself, and the row it refers to can
 * legitimately have been acknowledged again since. Re-reading would hand the
 * port the *latest* status while claiming to describe this one.
 */
@Injectable()
export class PayrollAckConsumer implements OutboxEventConsumer, OnModuleInit {
  readonly eventType = TIMESHEET_EVENTS.payrollExportAcked;
  private readonly logger = new Logger(PayrollAckConsumer.name);

  constructor(
    @Inject(TIMESHEET_PAYROLL_HANDOFF_PORT)
    private readonly port: TimesheetPayrollHandoffPort,
    private readonly registry: OutboxConsumerRegistry,
  ) {}

  /** Without this the publisher throws on the event type and dead-letters every ack. */
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
