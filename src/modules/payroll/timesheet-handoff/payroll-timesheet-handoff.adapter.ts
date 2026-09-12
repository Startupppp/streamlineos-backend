import { Injectable, Logger } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { payrollCommandReceipts } from "../../../db/schema";
import { isUniqueViolation } from "../../../common/db/postgres-error";
import type {
  TimesheetPayrollHandoffPort,
} from "../../timesheets/payroll/handoff/handoff.port";
import {
  payrollAckPayloadSchema,
  payrollHandoffPayloadSchema,
  type PayrollAckPayload,
  type PayrollHandoffPayload,
} from "../../timesheets/payroll/handoff/handoff.schemas";

const DELIVER_COMMAND = "timesheet.handoff.deliver";
const ACK_COMMAND = "timesheet.handoff.ack";

/**
 * Payroll's implementation of TimesheetPayrollHandoffPort.
 *
 * Durable on `payroll_command_receipts` keyed by the outbox idempotency key,
 * so a publisher retry of the same event is a no-op. Hours stay hours — this
 * adapter does not price them. A later payroll run reads the SUCCEEDED
 * receipt by exportId rather than asking timesheets again.
 */
@Injectable()
export class PayrollTimesheetHandoffAdapter implements TimesheetPayrollHandoffPort {
  private readonly logger = new Logger(PayrollTimesheetHandoffAdapter.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async deliver(payload: PayrollHandoffPayload): Promise<void> {
    const parsed = payrollHandoffPayloadSchema.parse(payload);
    await this.record({
      orgId: parsed.organizationId,
      command: DELIVER_COMMAND,
      idempotencyKey: parsed.idempotencyKey,
      response: {
        exportId: parsed.exportId,
        periodStart: parsed.periodStart,
        periodEnd: parsed.periodEnd,
        entryCount: parsed.entryCount,
        totalHours: parsed.totalHours,
        currency: parsed.currency,
        mapping: parsed.mapping,
        rows: parsed.rows,
        ackPath: parsed.ackPath,
        exportedAt: parsed.exportedAt,
      },
    });
    this.logger.log(
      `payroll accepted timesheet export ${parsed.exportId} org=${parsed.organizationId} ` +
        `workers=${parsed.rows.length} hours=${parsed.totalHours}`,
    );
  }

  async acknowledged(payload: PayrollAckPayload): Promise<void> {
    const parsed = payrollAckPayloadSchema.parse(payload);
    await this.record({
      orgId: parsed.organizationId,
      command: ACK_COMMAND,
      idempotencyKey: parsed.idempotencyKey,
      response: {
        exportId: parsed.exportId,
        status: parsed.status,
        ackBy: parsed.ackBy,
        ackAt: parsed.ackAt,
        note: parsed.note ?? null,
      },
    });
    const line =
      `payroll export ${parsed.exportId} acknowledged ${parsed.status} ` +
      `by ${parsed.ackBy} at ${parsed.ackAt}`;
    if (parsed.status === "REJECTED" || parsed.status === "FAILED") this.logger.warn(line);
    else this.logger.log(line);
  }

  private async record(input: {
    orgId: string;
    command: string;
    idempotencyKey: string;
    response: unknown;
  }): Promise<void> {
    const existing = await this.db.query.payrollCommandReceipts.findFirst({
      where: and(
        eq(payrollCommandReceipts.orgId, input.orgId),
        eq(payrollCommandReceipts.command, input.command),
        eq(payrollCommandReceipts.idempotencyKey, input.idempotencyKey),
      ),
    });
    if (existing?.status === "SUCCEEDED") return;

    try {
      await this.db.insert(payrollCommandReceipts).values({
        orgId: input.orgId,
        command: input.command,
        idempotencyKey: input.idempotencyKey,
        status: "SUCCEEDED",
        response: input.response,
        finishedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });
    } catch (err) {
      if (isUniqueViolation(err)) return;
      throw err;
    }
  }
}
