import type { TimesheetReadinessFacts } from "../../../timesheets/payroll/payroll-readiness-facts.service";
import type {
  PayrollReadiness,
  ReadinessException,
  ReadinessExport,
  ReadinessOwner,
  ReadinessStage,
} from "../dto/readiness-response.schemas";

export const READINESS_OWNERS = {
  timesheetApprovers: { label: "Timesheet approvers", permission: "timesheets:approvals:manage" },
  timesheetExporter: { label: "Timesheet administrator", permission: "timesheets:payroll:export" },
  payrollAdmin: { label: "Payroll administrator", permission: "payroll:runs:manage" },
} as const satisfies Record<string, ReadinessOwner>;

const RUN_GENERATED_STATUSES = new Set([
  "PREVIEW_READY",
  "EXCEPTIONS_FOUND",
  "PENDING_APPROVAL",
  "APPROVED",
  "LOCKED",
  "PAID",
  "PAYSLIPS_PUBLISHED",
  "CLOSED",
]);

export interface ReadinessLedgerInput {
  month: string;
  facts: TimesheetReadinessFacts;
  receivedAtByExportId: ReadonlyMap<number, Date>;
  inputs: { status: string; lockedAt: Date | null } | null;
  run: { id: number; status: string; createdAt: Date } | null;
  cutoff: { type: string; date: string; title: string } | null;
  people: PayrollReadiness["people"];
}

function hours(value: string): string {
  return `${Number(value).toFixed(2)}h`;
}

function exportsOf(input: ReadinessLedgerInput): ReadinessExport[] {
  return input.facts.exports.map((row) => ({
    id: row.id,
    exportedAt: row.createdAt.toISOString(),
    dateRangeStart: row.dateRangeStart,
    dateRangeEnd: row.dateRangeEnd,
    entryCount: row.entryCount,
    totalHours: row.totalHours,
    workerCount: row.workerCount,
    receivedAt: input.receivedAtByExportId.get(row.id) ?? null,
    ackStatus: row.ackStatus,
    ackAt: row.ackAt,
    ackNote: row.ackNote,
  }));
}

function stagesOf(input: ReadinessLedgerInput, latest: ReadinessExport | null): ReadinessStage[] {
  const { periods, approvedNotExported } = input.facts;
  const awaiting = periods.awaitingApproval + periods.unsubmitted + periods.rejected;
  const approvedStage: ReadinessStage = {
    key: "timesheets_approved",
    label: "Timesheets approved",
    status: awaiting === 0 ? "done" : "pending",
    owner: READINESS_OWNERS.timesheetApprovers,
    at: null,
    detail:
      awaiting === 0
        ? `${periods.approved + periods.locked} timesheet periods approved for the window.`
        : `${periods.awaitingApproval} awaiting a decision, ${periods.unsubmitted} not yet submitted, ${periods.rejected} rejected.`,
    action: periods.awaitingApproval > 0 ? { label: `Review ${periods.awaitingApproval} submitted`, href: "/timesheets/approvals" } : null,
  };

  const unexported = approvedNotExported.entryCount > 0;
  const exportedStage: ReadinessStage = {
    key: "timesheets_exported",
    label: "Hours exported to payroll",
    status: latest === null ? "pending" : unexported ? "pending" : "done",
    owner: READINESS_OWNERS.timesheetExporter,
    at: latest ? new Date(latest.exportedAt) : null,
    detail:
      latest === null
        ? "No payroll export covers this window yet."
        : unexported
          ? `Export #${latest.id} sent ${hours(latest.totalHours)}; ${hours(approvedNotExported.hours)} approved since are not exported.`
          : `Export #${latest.id} sent ${hours(latest.totalHours)} for ${latest.workerCount} workers.`,
    action: latest === null || unexported ? { label: "Export approved hours", href: "/timesheets/payroll" } : null,
  };

  const receivedStage: ReadinessStage = {
    key: "handoff_received",
    label: "Received by payroll",
    status: latest === null ? "blocked" : latest.receivedAt || latest.ackAt ? "done" : "pending",
    owner: READINESS_OWNERS.payrollAdmin,
    at: latest?.receivedAt ?? latest?.ackAt ?? null,
    detail:
      latest === null
        ? "Nothing to receive until hours are exported."
        : latest.receivedAt
          ? `Payroll recorded export #${latest.id}.`
          : latest.ackAt
            ? `Export #${latest.id} was acknowledged, so it was received.`
            : `Export #${latest.id} has not been recorded by payroll yet; the handoff relay may still be delivering it.`,
    action: null,
  };

  const rejected = latest?.ackStatus === "REJECTED" || latest?.ackStatus === "FAILED";
  const acknowledgedStage: ReadinessStage = {
    key: "handoff_acknowledged",
    label: "Handoff acknowledged",
    status: latest === null ? "blocked" : rejected ? "blocked" : latest.ackAt ? "done" : "pending",
    owner: READINESS_OWNERS.payrollAdmin,
    at: latest?.ackAt ?? null,
    detail:
      latest === null
        ? "Nothing to acknowledge until hours are exported."
        : rejected
          ? `Export #${latest.id} was ${latest.ackStatus === "REJECTED" ? "rejected" : "marked failed"}${latest.ackNote ? `: ${latest.ackNote}` : "."}`
          : latest.ackAt
            ? `Export #${latest.id} acknowledged ${latest.ackStatus ?? ""}`.trim() + "."
            : `Export #${latest.id} is waiting for payroll to accept or reject it.`,
    action: latest !== null && !latest.ackAt ? { label: "Acknowledge export", href: "/timesheets/payroll" } : null,
  };

  const locked = input.inputs?.status === "locked";
  const inputsStage: ReadinessStage = {
    key: "inputs_locked",
    label: "Payroll inputs locked",
    status: locked ? "done" : "pending",
    owner: READINESS_OWNERS.payrollAdmin,
    at: locked ? (input.inputs?.lockedAt ?? null) : null,
    detail: locked ? "Inputs for the month are locked." : input.inputs ? `Input period is ${input.inputs.status}.` : "No input period has been built for the month.",
    action: locked ? null : { label: "Build and lock inputs", href: "/payroll/inputs" },
  };

  const generated = input.run !== null && RUN_GENERATED_STATUSES.has(input.run.status);
  const runStage: ReadinessStage = {
    key: "run_generated",
    label: "Payroll run generated",
    status: generated ? "done" : "pending",
    owner: READINESS_OWNERS.payrollAdmin,
    at: generated ? input.run?.createdAt ?? null : null,
    detail: input.run ? `Run #${input.run.id} is ${input.run.status}.` : "No payroll run exists for the month.",
    action: input.run ? { label: "Open run", href: `/payroll/runs/${input.run.id}` } : { label: "Create run", href: "/payroll/runs" },
  };

  return [approvedStage, exportedStage, receivedStage, acknowledgedStage, inputsStage, runStage];
}

function exceptionsOf(input: ReadinessLedgerInput, latest: ReadinessExport | null): ReadinessException[] {
  const { periods, approvedNotExported, drift } = input.facts;
  const found: ReadinessException[] = [];

  if (periods.awaitingApproval > 0)
    found.push({
      code: "TIMESHEETS_AWAITING_APPROVAL",
      severity: "warning",
      message: `${periods.awaitingApproval} submitted timesheet periods have no decision yet; their hours are not payable until approved.`,
      owner: READINESS_OWNERS.timesheetApprovers,
      action: { label: "Review submitted", href: "/timesheets/approvals" },
      period: null,
    });

  if (latest !== null && approvedNotExported.entryCount > 0)
    found.push({
      code: "APPROVED_HOURS_NOT_EXPORTED",
      severity: "warning",
      message: `${hours(approvedNotExported.hours)} across ${approvedNotExported.entryCount} entries were approved after export #${latest.id} and are not in payroll.`,
      owner: READINESS_OWNERS.timesheetExporter,
      action: { label: "Export again", href: "/timesheets/payroll" },
      period: null,
    });

  if (latest !== null && (latest.ackStatus === "REJECTED" || latest.ackStatus === "FAILED"))
    found.push({
      code: "EXPORT_REJECTED",
      severity: "blocker",
      message: `Payroll ${latest.ackStatus === "REJECTED" ? "rejected" : "could not process"} export #${latest.id}${latest.ackNote ? `: ${latest.ackNote}` : "."}`,
      owner: READINESS_OWNERS.timesheetExporter,
      action: { label: "Review export", href: "/timesheets/payroll" },
      period: null,
    });

  for (const row of drift)
    found.push({
      code: "PERIOD_CHANGED_AFTER_EXPORT",
      severity: "blocker",
      message: `${row.userName ?? row.userEmail ?? "A worker"}'s ${row.periodStart} to ${row.periodEnd} period is ${row.status} but ${hours(row.exportedHours)} from it went to payroll in export #${row.exportId}.`,
      owner: READINESS_OWNERS.payrollAdmin,
      action: { label: "Reconcile period", href: `/timesheets/approvals?period=${row.periodId}` },
      period: {
        periodId: row.periodId,
        userId: row.userId,
        userName: row.userName,
        userEmail: row.userEmail,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        status: row.status,
        exportId: row.exportId,
        exportedEntryCount: row.exportedEntryCount,
        exportedHours: row.exportedHours,
        changedAt: row.updatedAt.toISOString(),
      },
    });

  return found;
}

export function buildReadinessLedger(input: ReadinessLedgerInput): PayrollReadiness {
  const exports = exportsOf(input);
  const latest = exports[0] ?? null;
  const { periods, approvedNotExported } = input.facts;
  return {
    month: input.month,
    window: input.facts.window,
    cutoff: input.cutoff,
    timesheets: {
      unsubmitted: periods.unsubmitted,
      awaitingApproval: periods.awaitingApproval,
      approved: periods.approved,
      locked: periods.locked,
      rejected: periods.rejected,
      approvedHoursNotExported: approvedNotExported.hours,
      approvedEntriesNotExported: approvedNotExported.entryCount,
    },
    inputs: { status: input.inputs?.status ?? null, lockedAt: input.inputs?.lockedAt ?? null },
    run: input.run ? { id: input.run.id, status: input.run.status, createdAt: input.run.createdAt.toISOString() } : null,
    stages: stagesOf(input, latest),
    exports,
    exceptions: exceptionsOf(input, latest),
    people: input.people,
  };
}
