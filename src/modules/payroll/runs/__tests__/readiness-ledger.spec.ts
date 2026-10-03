import { buildReadinessLedger, type ReadinessLedgerInput } from "../lib/readiness-ledger";
import type { TimesheetReadinessFacts } from "../../../timesheets/payroll/payroll-readiness-facts.service";

const EXPORTED_AT = new Date("2026-09-05T10:00:00.000Z");
const RECEIVED_AT = new Date("2026-09-05T10:00:03.000Z");
const ACKED_AT = new Date("2026-09-06T08:00:00.000Z");

const EXPORT: TimesheetReadinessFacts["exports"][number] = {
  id: 41,
  createdAt: EXPORTED_AT,
  dateRangeStart: "2026-09-01",
  dateRangeEnd: "2026-09-30",
  entryCount: 240,
  totalHours: "1920.00",
  workerCount: 12,
  ackStatus: "ACCEPTED",
  ackAt: ACKED_AT,
  ackNote: null,
};

function facts(overrides: Partial<TimesheetReadinessFacts> = {}): TimesheetReadinessFacts {
  return {
    window: { start: "2026-09-01", end: "2026-09-30" },
    periods: { unsubmitted: 0, awaitingApproval: 0, approved: 12, locked: 0, rejected: 0 },
    exports: [EXPORT],
    approvedNotExported: { entryCount: 0, hours: "0" },
    drift: [],
    ...overrides,
  };
}

function input(overrides: Partial<ReadinessLedgerInput> = {}): ReadinessLedgerInput {
  return {
    month: "2026-09",
    facts: facts(),
    receivedAtByExportId: new Map([[41, RECEIVED_AT]]),
    inputs: { status: "locked", lockedAt: new Date("2026-09-07T00:00:00.000Z") },
    run: { id: 7, status: "PREVIEW_READY", createdAt: new Date("2026-09-08T00:00:00.000Z") },
    cutoff: { type: "ATTENDANCE_CUTOFF", date: "2026-09-25", title: "Attendance cut-off" },
    people: { payable: 0, withSalary: 0, payableWithoutSalary: 0, needsPayeeLink: 0, payableWithoutSalarySample: [] },
    ...overrides,
  };
}

const statuses = (ledger: ReturnType<typeof buildReadinessLedger>) => Object.fromEntries(ledger.stages.map((stage) => [stage.key, stage.status]));

describe("buildReadinessLedger — the export → received → acknowledged → locked → run chain", () => {
  it("marks every stage done, with its timestamp, once the month has been handed off, locked and generated", () => {
    const ledger = buildReadinessLedger(input());

    expect(statuses(ledger)).toEqual({
      timesheets_approved: "done",
      timesheets_exported: "done",
      handoff_received: "done",
      handoff_acknowledged: "done",
      inputs_locked: "done",
      run_generated: "done",
    });
    expect(ledger.stages.map((stage) => stage.at)).toEqual([
      null,
      EXPORTED_AT,
      RECEIVED_AT,
      ACKED_AT,
      new Date("2026-09-07T00:00:00.000Z"),
      new Date("2026-09-08T00:00:00.000Z"),
    ]);
    expect(ledger.exceptions).toEqual([]);
    expect(ledger.exports[0]).toMatchObject({ id: 41, receivedAt: RECEIVED_AT, ackStatus: "ACCEPTED" });
  });

  it("hands the first task to timesheet approvers while periods await a decision", () => {
    const ledger = buildReadinessLedger(
      input({ facts: facts({ periods: { unsubmitted: 2, awaitingApproval: 3, approved: 7, locked: 0, rejected: 0 } }) }),
    );

    const approved = ledger.stages[0];
    expect(approved).toMatchObject({
      key: "timesheets_approved",
      status: "pending",
      owner: { label: "Timesheet approvers", permission: "timesheets:approvals:manage" },
      action: { label: "Review 3 submitted", href: "/timesheets/approvals" },
    });
    expect(ledger.exceptions).toEqual([expect.objectContaining({ code: "TIMESHEETS_AWAITING_APPROVAL", severity: "warning" })]);
  });

  it("blocks everything downstream of an export that does not exist yet", () => {
    const ledger = buildReadinessLedger(input({ facts: facts({ exports: [] }), receivedAtByExportId: new Map() }));

    expect(statuses(ledger)).toMatchObject({
      timesheets_exported: "pending",
      handoff_received: "blocked",
      handoff_acknowledged: "blocked",
    });
    expect(ledger.stages[1]?.action).toEqual({ label: "Export approved hours", href: "/timesheets/payroll" });
  });

  it("shows an export payroll has not recorded as pending, not received", () => {
    const ledger = buildReadinessLedger(
      input({
        facts: facts({ exports: [{ ...EXPORT, ackStatus: null, ackAt: null }] }),
        receivedAtByExportId: new Map(),
      }),
    );

    expect(statuses(ledger)).toMatchObject({ handoff_received: "pending", handoff_acknowledged: "pending" });
    expect(ledger.stages[3]?.action).toEqual({ label: "Acknowledge export", href: "/timesheets/payroll" });
  });

  it("treats an acknowledgement as proof of receipt when the delivery receipt has been pruned", () => {
    const ledger = buildReadinessLedger(input({ receivedAtByExportId: new Map() }));

    expect(ledger.stages[2]).toMatchObject({ key: "handoff_received", status: "done", at: ACKED_AT });
  });

  it("raises a blocker when payroll rejected the export", () => {
    const ledger = buildReadinessLedger(
      input({ facts: facts({ exports: [{ ...EXPORT, ackStatus: "REJECTED", ackNote: "Wrong pay period" }] }) }),
    );

    expect(statuses(ledger).handoff_acknowledged).toBe("blocked");
    expect(ledger.exceptions).toEqual([
      expect.objectContaining({ code: "EXPORT_REJECTED", severity: "blocker", message: "Payroll rejected export #41: Wrong pay period" }),
    ]);
  });

  it("names the hours approved after the export so they are not silently left out of payroll", () => {
    const ledger = buildReadinessLedger(input({ facts: facts({ approvedNotExported: { entryCount: 6, hours: "48.50" } }) }));

    expect(statuses(ledger).timesheets_exported).toBe("pending");
    expect(ledger.exceptions).toEqual([
      expect.objectContaining({
        code: "APPROVED_HOURS_NOT_EXPORTED",
        owner: { label: "Timesheet administrator", permission: "timesheets:payroll:export" },
        action: { label: "Export again", href: "/timesheets/payroll" },
        message: "48.50h across 6 entries were approved after export #41 and are not in payroll.",
      }),
    ]);
  });

  it("surfaces a period that was reopened after its hours reached payroll as a blocker owned by payroll", () => {
    const ledger = buildReadinessLedger(
      input({
        facts: facts({
          drift: [
            {
              periodId: 99,
              userId: "usr-asha",
              userName: "Asha",
              userEmail: "asha@example.test",
              periodStart: "2026-09-07",
              periodEnd: "2026-09-13",
              status: "DRAFT",
              exportId: 41,
              exportedEntryCount: 5,
              exportedHours: "40.00",
              updatedAt: new Date("2026-09-09T12:00:00.000Z"),
            },
          ],
        }),
      }),
    );

    expect(ledger.exceptions).toEqual([
      expect.objectContaining({
        code: "PERIOD_CHANGED_AFTER_EXPORT",
        severity: "blocker",
        owner: { label: "Payroll administrator", permission: "payroll:runs:manage" },
        action: { label: "Reconcile period", href: "/timesheets/approvals?period=99" },
        message: "Asha's 2026-09-07 to 2026-09-13 period is DRAFT but 40.00h from it went to payroll in export #41.",
        period: expect.objectContaining({ periodId: 99, exportId: 41, changedAt: "2026-09-09T12:00:00.000Z" }),
      }),
    ]);
  });

  it("reports the input period and the run honestly when neither exists", () => {
    const ledger = buildReadinessLedger(input({ inputs: null, run: null }));

    expect(ledger.stages[4]).toMatchObject({ key: "inputs_locked", status: "pending", at: null, action: { href: "/payroll/inputs" } });
    expect(ledger.stages[5]).toMatchObject({ key: "run_generated", status: "pending", action: { label: "Create run", href: "/payroll/runs" } });
    expect(ledger.inputs).toEqual({ status: null, lockedAt: null });
    expect(ledger.run).toBeNull();
  });

  it("keeps a PREPARING run as not yet generated", () => {
    const ledger = buildReadinessLedger(input({ run: { id: 7, status: "PREPARING", createdAt: new Date() } }));

    expect(ledger.stages[5]).toMatchObject({ status: "pending", at: null, action: { label: "Open run", href: "/payroll/runs/7" } });
  });
});
