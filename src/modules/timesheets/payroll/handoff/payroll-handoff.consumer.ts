import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { timesheetExports } from "../../../../db/schema";
import {
  OutboxConsumerRegistry,
  outboxEffectIdempotencyKey,
  type OutboxEventConsumer,
  type OutboxEventRow,
} from "../../../../common/outbox/outbox-consumer.registry";
import { resolveMapping } from "../lib/payroll-calc";
import { TIMESHEET_PAYROLL_HANDOFF_PORT, type TimesheetPayrollHandoffPort } from "./handoff.port";
import {
  TIMESHEET_EVENTS,
  handoffWorkerRowSchema,
  payrollExportReadyEventSchema,
  type PayrollHandoffPayload,
} from "./handoff.schemas";

const CONSUMER_NAME = "timesheets-payroll-handoff";

@Injectable()
export class PayrollHandoffConsumer implements OutboxEventConsumer, OnModuleInit {
  readonly eventType = TIMESHEET_EVENTS.payrollExportReady;
  private readonly logger = new Logger(PayrollHandoffConsumer.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(TIMESHEET_PAYROLL_HANDOFF_PORT)
    private readonly port: TimesheetPayrollHandoffPort,
    private readonly registry: OutboxConsumerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(event: OutboxEventRow): Promise<void> {
    const parsed = payrollExportReadyEventSchema.safeParse(event.payload);
    if (!parsed.success) {
      throw new Error(
        `${TIMESHEET_EVENTS.payrollExportReady} payload does not match its schema: ${parsed.error.message}`,
      );
    }
    const body = parsed.data;

    const [row] = await this.db
      .select({
        id: timesheetExports.id,
        dateRangeStart: timesheetExports.dateRangeStart,
        dateRangeEnd: timesheetExports.dateRangeEnd,
        snapshot: timesheetExports.snapshot,
        filters: timesheetExports.filters,
        entryCount: timesheetExports.entryCount,
        totalHours: timesheetExports.totalHours,
        createdAt: timesheetExports.createdAt,
      })
      .from(timesheetExports)
      .where(
        and(
          eq(timesheetExports.orgId, event.organizationId),
          eq(timesheetExports.id, body.export_id),
        ),
      )
      .limit(1);

    if (!row) {
      throw new Error(
        `payroll export ${body.export_id} for org ${event.organizationId} is gone; cannot hand off`,
      );
    }

    const rows = handoffWorkerRowSchema
      .array()
      .parse(Array.isArray(row.snapshot) ? row.snapshot : []);

    const rawMapping =
      row.filters && typeof row.filters === "object" && "mapping" in row.filters
        ? (row.filters as { mapping: unknown }).mapping
        : null;
    const mapping = resolveMapping(rawMapping);

    const payload: PayrollHandoffPayload = {
      organizationId: event.organizationId,
      exportId: row.id,
      periodStart: row.dateRangeStart,
      periodEnd: row.dateRangeEnd,
      currency: null,
      entryCount: row.entryCount,
      totalHours: Number(row.totalHours),
      mapping,
      rows,
      idempotencyKey: outboxEffectIdempotencyKey(event, CONSUMER_NAME),
      ackPath: `timesheets/payroll/exports/${row.id}/ack`,
      exportedAt: row.createdAt.toISOString(),
    };

    await this.port.deliver(payload);
    this.logger.debug(`handed off payroll export ${row.id} for ${event.organizationId}`);
  }
}
