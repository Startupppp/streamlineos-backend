import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { payrollCalendarEvents, payrollCommandReceipts, payrollRuns } from "../../../db/schema";
import { hrPayrollInputPeriods } from "../../../db/schema/payroll/input-capture";
import { TimesheetPayrollReadinessFactsService } from "../../timesheets/payroll/payroll-readiness-facts.service";
import { buildReadinessLedger } from "./lib/readiness-ledger";
import type { PayrollReadiness } from "./dto/readiness-response.schemas";

const HANDOFF_DELIVER_COMMAND = "timesheet.handoff.deliver";

export function monthWindow(month: string): { start: string; end: string } {
  const [year, monthOfYear] = month.split("-").map(Number);
  const start = new Date(Date.UTC(year, monthOfYear - 1, 1));
  const end = new Date(Date.UTC(year, monthOfYear, 0));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

@Injectable()
export class PayrollReadinessService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly timesheetFacts: TimesheetPayrollReadinessFactsService,
  ) {}

  async getReadiness(orgId: string, month: string): Promise<PayrollReadiness> {
    const window = monthWindow(month);
    const facts = await this.timesheetFacts.facts(orgId, window);
    const exportIds = facts.exports.map((row) => row.id);

    const [receipts, inputRows, runRows, cutoffRows] = await Promise.all([
      exportIds.length === 0
        ? Promise.resolve([])
        : this.db
            .select({
              exportId: sql<number>`(${payrollCommandReceipts.response} ->> 'exportId')::int`,
              finishedAt: payrollCommandReceipts.finishedAt,
            })
            .from(payrollCommandReceipts)
            .where(
              and(
                eq(payrollCommandReceipts.orgId, orgId),
                eq(payrollCommandReceipts.command, HANDOFF_DELIVER_COMMAND),
                eq(payrollCommandReceipts.status, "SUCCEEDED"),
                inArray(sql`(${payrollCommandReceipts.response} ->> 'exportId')::int`, exportIds),
              ),
            )
            .limit(exportIds.length),
      this.db
        .select({ status: hrPayrollInputPeriods.status, lockedAt: hrPayrollInputPeriods.lockedAt })
        .from(hrPayrollInputPeriods)
        .where(and(eq(hrPayrollInputPeriods.orgId, orgId), eq(hrPayrollInputPeriods.periodKey, month)))
        .limit(1),
      this.db
        .select({ id: payrollRuns.id, status: payrollRuns.status, createdAt: payrollRuns.createdAt })
        .from(payrollRuns)
        .where(and(eq(payrollRuns.orgId, orgId), eq(payrollRuns.month, month), eq(payrollRuns.runType, "REGULAR")))
        .orderBy(desc(payrollRuns.createdAt))
        .limit(1),
      this.db
        .select({ type: payrollCalendarEvents.type, date: payrollCalendarEvents.date, title: payrollCalendarEvents.title })
        .from(payrollCalendarEvents)
        .where(
          and(
            eq(payrollCalendarEvents.orgId, orgId),
            eq(payrollCalendarEvents.month, month),
            eq(payrollCalendarEvents.type, "ATTENDANCE_CUTOFF"),
          ),
        )
        .orderBy(asc(payrollCalendarEvents.date))
        .limit(1),
    ]);

    const receivedAtByExportId = new Map<number, Date>();
    for (const receipt of receipts) if (receipt.finishedAt) receivedAtByExportId.set(receipt.exportId, receipt.finishedAt);

    return buildReadinessLedger({
      month,
      facts,
      receivedAtByExportId,
      inputs: inputRows[0] ?? null,
      run: runRows[0] ?? null,
      cutoff: cutoffRows[0] ?? null,
    });
  }
}
