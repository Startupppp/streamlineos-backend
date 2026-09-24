import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.types";
import { requireApprovedDatabaseUrl } from "../../../../test/db-spec-guard";
import { createProbeOrg, dropProbeOrg, type ProbeOrg } from "../../../../../test/helpers/probe-org";
import { TimesheetPayrollReadinessFactsService } from "../../../timesheets/payroll/payroll-readiness-facts.service";
import { PayrollReadinessService, monthWindow } from "../readiness.service";

jest.setTimeout(120_000);

function connect() {
  const raw = requireApprovedDatabaseUrl({ spec: "readiness.db.spec.ts", vars: ["HR_PROBE_DATABASE_URL", "DATABASE_URL"] });
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return postgres(url.toString(), { prepare: false, max: 2, ssl: local ? false : "require", connect_timeout: 30, onnotice: () => {} });
}

const MONTH = "2026-09";

describe("Payroll readiness against a real schema", () => {
  let sql: ReturnType<typeof connect>;
  let db: Db;
  let org: ProbeOrg;
  let service: PayrollReadinessService;
  let workerUserId: string;
  let workerMembershipId: number;
  let counter = 0;

  async function period(status: string, start: string, end: string): Promise<number> {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO timesheet_periods (org_id, user_membership_id, period_start, period_end, status, total_hours)
      VALUES (${org.orgId}, ${workerMembershipId}, ${start}, ${end}, ${status}::timesheet_period_status, '40')
      RETURNING id`;
    return row.id;
  }

  async function entry(periodId: number, date: string, hours: string, options: { status?: string; payrollStatus?: string; exportId?: number | null } = {}): Promise<number> {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO timesheets (org_id, user_membership_id, timesheet_period_id, date, hours, status, payroll_status, payroll_export_id)
      VALUES (${org.orgId}, ${workerMembershipId}, ${periodId}, ${date}, ${hours}, ${options.status ?? "APPROVED"}::timesheet_entry_status, ${options.payrollStatus ?? "UNPROCESSED"}::timesheet_payroll_status, ${options.exportId ?? null})
      RETURNING id`;
    return row.id;
  }

  async function payrollExport(start: string, end: string, totalHours: string, createdAt: string): Promise<number> {
    counter += 1;
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO timesheet_exports (org_id, export_type, status, date_range_start, date_range_end, format, snapshot, entry_count, total_hours, idempotency_key, created_at)
      VALUES (${org.orgId}, 'PAYROLL', 'COMPLETED', ${start}, ${end}, 'CSV', ${JSON.stringify([{ userId: workerUserId, totalPayableHours: Number(totalHours) }])}::jsonb, 5, ${totalHours}, ${`readiness-${counter}`}, ${createdAt}::timestamp)
      RETURNING id`;
    return row.id;
  }

  beforeAll(async () => {
    sql = connect();
    db = drizzle(sql, { schema });
    org = await createProbeOrg(sql, "payroll-readiness");
    workerUserId = org.userId;
    workerMembershipId = org.membershipId;
    service = new PayrollReadinessService(db, new TimesheetPayrollReadinessFactsService(db));
  });

  afterAll(async () => {
    if (org) {
      await sql`DELETE FROM payroll_command_receipts WHERE org_id = ${org.orgId}`;
      await sql`DELETE FROM payroll_runs WHERE org_id = ${org.orgId}`;
      await sql`DELETE FROM hr_payroll_input_periods WHERE org_id = ${org.orgId}`;
      await sql`DELETE FROM payroll_calendar_events WHERE org_id = ${org.orgId}`;
      await sql`DELETE FROM timesheets WHERE org_id = ${org.orgId}`;
      await sql`DELETE FROM timesheet_periods WHERE org_id = ${org.orgId}`;
      await sql`DELETE FROM timesheet_exports WHERE org_id = ${org.orgId}`;
      await dropProbeOrg(sql, org, []);
    }
    if (sql) await sql.end({ timeout: 5 });
  });

  it("derives a calendar month window", () => {
    expect(monthWindow("2026-02")).toEqual({ start: "2026-02-01", end: "2026-02-28" });
    expect(monthWindow("2028-02")).toEqual({ start: "2028-02-01", end: "2028-02-29" });
    expect(monthWindow("2026-12")).toEqual({ start: "2026-12-01", end: "2026-12-31" });
  });

  it("reads an empty month as nothing to hand off, not as an error", async () => {
    const ledger = await service.getReadiness(org.orgId, "2025-01");

    expect(ledger.timesheets).toMatchObject({ unsubmitted: 0, awaitingApproval: 0, approved: 0, approvedEntriesNotExported: 0 });
    expect(ledger.exports).toEqual([]);
    expect(ledger.exceptions).toEqual([]);
    expect(ledger.stages.map((stage) => stage.status)).toEqual(["done", "pending", "blocked", "blocked", "pending", "pending"]);
  });

  it("walks the chain from export through receipt, acknowledgement, locked inputs and a generated run, and flags a period reopened after export", async () => {
    const exportedPeriod = await period("APPROVED", "2026-09-07", "2026-09-13");
    const exportId = await payrollExport("2026-09-01", "2026-09-30", "40.00", "2026-09-14T09:00:00");
    for (const day of ["07", "08", "09", "10", "11"])
      await entry(exportedPeriod, `2026-09-${day}`, "8", { payrollStatus: "EXPORTED", exportId });
    await sql`UPDATE timesheet_exports SET ack_status = 'ACCEPTED', ack_at = '2026-09-15T08:00:00'::timestamp WHERE id = ${exportId}`;
    await sql`
      INSERT INTO payroll_command_receipts (org_id, command, idempotency_key, status, response, finished_at, expires_at)
      VALUES (${org.orgId}, 'timesheet.handoff.deliver', ${`deliver-${exportId}`}, 'SUCCEEDED', ${JSON.stringify({ exportId })}::jsonb, '2026-09-14T09:00:05'::timestamp, '2026-10-14T09:00:05'::timestamp)`;
    await sql`INSERT INTO hr_payroll_input_periods (org_id, period_key, status, locked_at) VALUES (${org.orgId}, ${MONTH}, 'locked', '2026-09-16T00:00:00'::timestamp)`;
    await sql`INSERT INTO payroll_runs (org_id, month, status, run_type) VALUES (${org.orgId}, ${MONTH}, 'PREVIEW_READY', 'REGULAR')`;
    await sql`INSERT INTO payroll_calendar_events (org_id, month, type, date, title) VALUES (${org.orgId}, ${MONTH}, 'ATTENDANCE_CUTOFF', '2026-09-25', 'Attendance cut-off')`;

    const awaiting = await period("SUBMITTED", "2026-09-14", "2026-09-20");
    await entry(awaiting, "2026-09-14", "8", { status: "PENDING" });
    const approvedLater = await period("APPROVED", "2026-09-21", "2026-09-27");
    await entry(approvedLater, "2026-09-21", "6.5");

    const before = await service.getReadiness(org.orgId, MONTH);

    expect(before.cutoff).toEqual({ type: "ATTENDANCE_CUTOFF", date: "2026-09-25", title: "Attendance cut-off" });
    expect(before.timesheets).toMatchObject({ awaitingApproval: 1, approved: 2, approvedEntriesNotExported: 1, approvedHoursNotExported: "6.50" });
    expect(before.exports).toEqual([
      expect.objectContaining({ id: exportId, workerCount: 1, totalHours: "40.00", ackStatus: "ACCEPTED", receivedAt: new Date("2026-09-14T09:00:05.000Z") }),
    ]);
    expect(before.stages.map((stage) => stage.status)).toEqual(["pending", "pending", "done", "done", "done", "done"]);
    expect(before.exceptions.map((exception) => exception.code)).toEqual(["TIMESHEETS_AWAITING_APPROVAL", "APPROVED_HOURS_NOT_EXPORTED"]);

    await sql`UPDATE timesheet_periods SET status = 'DRAFT', updated_at = '2026-09-18T10:00:00'::timestamp WHERE id = ${exportedPeriod}`;

    const after = await service.getReadiness(org.orgId, MONTH);

    const drift = after.exceptions.find((exception) => exception.code === "PERIOD_CHANGED_AFTER_EXPORT");
    expect(drift).toMatchObject({
      severity: "blocker",
      period: { periodId: exportedPeriod, exportId, status: "DRAFT", exportedEntryCount: 5, exportedHours: "40.00", userId: workerUserId },
    });
  });

  it("does not read another organisation's exports, periods or runs", async () => {
    const other = await createProbeOrg(sql, "payroll-readiness-other");
    try {
      const ledger = await service.getReadiness(other.orgId, MONTH);

      expect(ledger.exports).toEqual([]);
      expect(ledger.run).toBeNull();
      expect(ledger.timesheets.approved).toBe(0);
      expect(ledger.exceptions).toEqual([]);
    } finally {
      await dropProbeOrg(sql, other, []);
    }
  });
});
