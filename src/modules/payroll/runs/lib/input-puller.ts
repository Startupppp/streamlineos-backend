import { and, eq, gte, inArray, lte } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import { attendance, leaveRequests } from "../../../../db/schema";
import {
  hrPayrollInputPeriods,
  hrPayrollInputSnapshots,
} from "../../../../db/schema/payroll/input-capture";
import { daysInMonth } from "./money";
import { asRecord } from "../../../../common/openapi/zod-operation-contracts";
import type { PayrollSourceRef } from "../../payroll.types";

export interface PulledInputs {
  userId: string;
  scheduledDays: string;
  paidDays: string;
  lopDays: string;
  halfDays: string;
  overtimeHours: string;
  shiftAllowanceUnits: string;
  holidayWorkDays: string;
  billableHours: string;
  /** DB enum: ATTENDANCE | LEAVE | TIMESHEET | UPLOAD | MANUAL */
  source: "ATTENDANCE" | "LEAVE" | "TIMESHEET" | "UPLOAD" | "MANUAL";
  /** True when values came from a locked hr_payroll_input_period snapshot. */
  fromLockedSnapshot?: boolean;
}

const PAID_STATUSES = ["PRESENT", "WFH", "HALFDAY", "HOLIDAY_WORK"];
const LOP_STATUSES = ["ABSENT", "LEAVE_WITHOUT_PAY"];

type SnapshotPayload = Record<string, unknown>;

export type SectionMap = Map<string, SnapshotPayload>;

function num(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/**
 * Largest number of payees whose inputs are pulled in one statement.
 * Bounds both the `IN (...)` list and the row payload each chunk can return:
 * a chunk reads at most CHUNK * 100 snapshot rows, CHUNK * daysInMonth
 * attendance rows and CHUNK * daysInMonth * 2 leave rows.
 */
export const PAYROLL_INPUT_PULL_CHUNK = 200;

/**
 * Batched multi-payee input pull. Prefers immutable locked payroll-input period
 * snapshots for the month and falls back to a live attendance/leave read for the
 * payees no snapshot covers.
 *
 * Round-trips are `1 + ceil(users / PAYROLL_INPUT_PULL_CHUNK) * 3` — bounded by
 * the chunk count, never one query per payee.
 */
export async function pullAttendanceInputsByUser(
  db: Db,
  orgId: string,
  userIds: string[],
  month: string,
  chunkSize: number = PAYROLL_INPUT_PULL_CHUNK,
): Promise<Map<string, PulledInputs>> {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new RangeError("Payroll input pull chunk size must be a positive integer");
  }

  const pulled = new Map<string, PulledInputs>();
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return pulled;

  const periodId = await getLockedInputPeriodId(db, orgId, month);

  for (let start = 0; start < unique.length; start += chunkSize) {
    const chunk = unique.slice(start, start + chunkSize);
    const lockedByUser =
      periodId == null
        ? new Map<string, SectionMap>()
        : await loadLockedSectionsByUser(db, orgId, periodId, chunk);

    const needsLive: string[] = [];
    for (const userId of chunk) {
      const locked = buildPulledInputsFromSections(userId, month, lockedByUser.get(userId));
      if (locked) pulled.set(userId, locked);
      else needsLive.push(userId);
    }

    if (needsLive.length === 0) continue;
    const live = await loadLiveAttendanceByUser(db, orgId, needsLive, month);
    for (const [userId, row] of live) if (row) pulled.set(userId, row);
  }

  return pulled;
}

export async function getLockedInputPeriodId(
  db: Db,
  orgId: string,
  month: string,
): Promise<number | null> {
  const [period] = await db
    .select({ id: hrPayrollInputPeriods.id })
    .from(hrPayrollInputPeriods)
    .where(
      and(
        eq(hrPayrollInputPeriods.orgId, orgId),
        eq(hrPayrollInputPeriods.periodKey, month),
        eq(hrPayrollInputPeriods.status, "locked"),
      ),
    )
    .limit(1);
  return period?.id ?? null;
}

export async function loadLockedSectionsByUser(
  db: Db,
  orgId: string,
  periodId: number,
  userIds: string[],
): Promise<Map<string, SectionMap>> {
  const byUser = new Map<string, SectionMap>();
  if (userIds.length === 0) return byUser;

  const snaps = await db
    .select({
      userId: hrPayrollInputSnapshots.userId,
      section: hrPayrollInputSnapshots.section,
      payload: hrPayrollInputSnapshots.payload,
      sourceRefs: hrPayrollInputSnapshots.sourceRefs,
    })
    .from(hrPayrollInputSnapshots)
    .where(
      and(
        eq(hrPayrollInputSnapshots.orgId, orgId),
        eq(hrPayrollInputSnapshots.periodId, periodId),
        inArray(hrPayrollInputSnapshots.userId, userIds),
      ),
    )
    .limit(Math.max(1, userIds.length * 100));

  for (const snap of snaps) {
    const payload = asRecord(snap.payload);
    if (!payload) continue;
    const sections = byUser.get(snap.userId) ?? new Map<string, SnapshotPayload>();
    sections.set(snap.section, snap.sourceRefs == null ? payload : { ...payload, sourceRefs: snap.sourceRefs });
    byUser.set(snap.userId, sections);
  }
  return byUser;
}

export function buildPulledInputsFromSections(
  userId: string,
  month: string,
  bySection: SectionMap | undefined,
): PulledInputs | null {
  if (!bySection || bySection.size === 0) return null;

  const attendanceSection = bySection.get("attendance") ?? {};
  const leave = bySection.get("leave") ?? {};
  const overtime = bySection.get("overtime") ?? {};

  const totalDays = daysInMonth(month);
  const payableDays = num(attendanceSection.payableDays, totalDays);
  const presentDays = num(attendanceSection.presentDays);
  const absentDays = num(attendanceSection.absentDays);
  const latePenaltyDays = num(attendanceSection.latePenaltyDays);
  const holidayWorkDays = num(attendanceSection.holidayWorkDays);
  const overtimeMinutes = num(attendanceSection.overtimeMinutes);

  const paidLeaveDays = num(leave.paidLeaveDays);
  const unpaidLeaveDays = num(leave.unpaidLeaveDays);
  const halfDayCount = num(leave.halfDayCount);
  const otHoursFromSection = num(overtime.totalHours);
  const overtimeHours =
    otHoursFromSection > 0 ? otHoursFromSection : overtimeMinutes / 60;

  const paidDays = presentDays + paidLeaveDays + halfDayCount * 0.5;
  const lopDays = absentDays + unpaidLeaveDays + latePenaltyDays + halfDayCount * 0.5;

  return {
    userId,
    scheduledDays: String(payableDays > 0 ? payableDays : totalDays),
    paidDays: paidDays.toFixed(1),
    lopDays: lopDays.toFixed(1),
    halfDays: String(halfDayCount),
    overtimeHours: overtimeHours.toFixed(2),
    shiftAllowanceUnits: "0",
    holidayWorkDays: String(holidayWorkDays),
    billableHours: "0",
    source: "UPLOAD",
    fromLockedSnapshot: true,
  };
}

export async function pullFromLockedSnapshots(
  db: Db,
  orgId: string,
  userId: string,
  month: string,
): Promise<PulledInputs | null> {
  const periodId = await getLockedInputPeriodId(db, orgId, month);
  if (periodId == null) return null;

  const byUser = await loadLockedSectionsByUser(db, orgId, periodId, [userId]);
  return buildPulledInputsFromSections(userId, month, byUser.get(userId));
}

export type PulledReimbursement = {
  amount: string;
  category: string;
  expenseId?: number;
  source?: PayrollSourceRef;
};

export type LockedCalcPulls = {
  fromLockedSnapshot: true;
  approvedReimbursements: PulledReimbursement[];
  consumedReimbursementIds: number[];
  activeLoans: {
    id: number;
    emiAmount: string | null;
    amount: string;
    paidEmis: number;
    totalEmis: number | null;
    adjustment: { type: string; amount: string | null } | null;
  }[];
  overtimeHours: string;
  lopSources: PayrollSourceRef[];
  overtimeSources: PayrollSourceRef[];
};

export function parseSourceRefs(value: unknown): PayrollSourceRef[] {
  if (!Array.isArray(value)) return [];
  const refs: PayrollSourceRef[] = [];
  for (const raw of value) {
    const ref = asRecord(raw);
    if (!ref || typeof ref.table !== "string" || typeof ref.label !== "string") continue;
    const id = typeof ref.id === "number" || typeof ref.id === "string" ? ref.id : null;
    refs.push({
      table: ref.table,
      id,
      label: ref.label,
      date: typeof ref.date === "string" ? ref.date : null,
      endDate: typeof ref.endDate === "string" ? ref.endDate : null,
    });
  }
  return refs;
}

function dayCount(n: number): string {
  return `${n} day${n === 1 ? "" : "s"}`;
}

export function lopSourcesFromSections(bySection: SectionMap | undefined): PayrollSourceRef[] {
  if (!bySection) return [];
  const attendanceSection = bySection.get("attendance") ?? {};
  const leave = bySection.get("leave") ?? {};
  const refs: PayrollSourceRef[] = [];
  const absentDays = num(attendanceSection.absentDays);
  if (absentDays > 0) refs.push({ table: "attendance", id: null, label: `Absent · ${dayCount(absentDays)}` });
  const latePenaltyDays = num(attendanceSection.latePenaltyDays);
  if (latePenaltyDays > 0) refs.push({ table: "attendance", id: null, label: `Late penalty · ${dayCount(latePenaltyDays)}` });
  refs.push(...parseSourceRefs(leave.sourceRefs));
  const halfDayCount = num(leave.halfDayCount);
  if (halfDayCount > 0) refs.push({ table: "leave_requests", id: null, label: `Half day · ${halfDayCount} × 0.5` });
  return refs;
}

const REIMBURSEMENT_SOURCE_TABLE: Record<string, string> = {
  reimbursement: "reimbursements",
  benefits_claim: "hr_insurance_claims",
  expense: "expenses",
};

function itemSourceRef(item: Record<string, unknown>, category: string): PayrollSourceRef | undefined {
  if (typeof item.id !== "number") return undefined;
  const source = typeof item.source === "string" ? item.source : "reimbursement";
  const table = REIMBURSEMENT_SOURCE_TABLE[source] ?? "reimbursements";
  const label =
    source === "expense"
      ? `Expense claim #${item.id} · ${category}`
      : source === "benefits_claim" && typeof item.description === "string"
        ? item.description
        : `Reimbursement #${item.id} · ${category}`;
  const rawDate = typeof item.date === "string" ? item.date : typeof item.approvedAt === "string" ? item.approvedAt : null;
  return { table, id: item.id, label, date: rawDate ? rawDate.slice(0, 10) : null };
}

export function buildCalcPullsFromSections(
  bySection: SectionMap | undefined,
): LockedCalcPulls | null {
  if (!bySection || bySection.size === 0) return null;

  const reimb = bySection.get("reimbursement") ?? {};
  const deduction = bySection.get("deduction") ?? {};
  const overtime = bySection.get("overtime") ?? {};
  const attendanceSection = bySection.get("attendance") ?? {};

  const items = Array.isArray(reimb.items) ? reimb.items : [];
  const approvedReimbursements: PulledReimbursement[] = [];
  const consumedReimbursementIds: number[] = [];

  for (const raw of items) {
    const item = asRecord(raw);
    if (!item) continue;
    const amount = item.amount;
    const category = typeof item.category === "string" ? item.category : "OTHER";
    const amountStr =
      typeof amount === "number"
        ? amount.toFixed(2)
        : typeof amount === "string"
          ? amount
          : "0";
    const source = itemSourceRef(item, category);
    const expenseId = item.source === "expense" && typeof item.id === "number" ? item.id : undefined;
    approvedReimbursements.push({
      amount: amountStr,
      category,
      ...(expenseId !== undefined ? { expenseId } : {}),
      ...(source ? { source } : {}),
    });
    if (typeof item.id === "number" && item.source !== "benefits_claim" && expenseId === undefined) {
      consumedReimbursementIds.push(item.id);
    }
  }

  const loansRaw = Array.isArray(deduction.activeLoans) ? deduction.activeLoans : [];
  const activeLoans: LockedCalcPulls["activeLoans"] = loansRaw
    .filter((l): l is Record<string, unknown> => !!l && typeof l === "object")
    .map((l) => ({
      id: num(l.id),
      emiAmount: l.emiAmount == null ? null : String(l.emiAmount),
      amount: String(l.amount ?? "0"),
      paidEmis: num(l.paidEmis),
      totalEmis: l.totalEmis == null ? null : num(l.totalEmis),
      adjustment: null,
    }))
    .filter((l) => l.id > 0);

  const otFromSection = num(overtime.totalHours);
  const otFromAttendance = num(attendanceSection.overtimeMinutes) / 60;
  const overtimeHours = (otFromSection > 0 ? otFromSection : otFromAttendance).toFixed(2);

  return {
    fromLockedSnapshot: true,
    approvedReimbursements,
    consumedReimbursementIds,
    activeLoans,
    overtimeHours,
    lopSources: lopSourcesFromSections(bySection),
    overtimeSources: parseSourceRefs(overtime.sourceRefs),
  };
}

/**
 * Variable pay / loan / OT from locked payroll-input snapshots.
 * Bonuses, incentives, tax declarations stay on live tables (not period-snapshotted).
 */
export async function pullCalcFromLockedSnapshots(
  db: Db,
  orgId: string,
  userId: string,
  month: string,
): Promise<LockedCalcPulls | null> {
  const periodId = await getLockedInputPeriodId(db, orgId, month);
  if (periodId == null) return null;

  const byUser = await loadLockedSectionsByUser(db, orgId, periodId, [userId]);
  return buildCalcPullsFromSections(byUser.get(userId));
}

type LiveAttendanceRow = { userId: string; status: string };
type LiveLeaveRow = { userId: string; lopDays: string | null };

export function buildLiveAttendanceInputs(
  userId: string,
  month: string,
  records: { status: string }[],
  leaveRows: { lopDays: string | null }[],
): PulledInputs | null {
  if (records.length === 0) {
    return null;
  }

  const totalDays = daysInMonth(month);

  let paidCount = 0;
  let lopCount = 0;
  let halfDayCount = 0;
  let holidayWorkCount = 0;

  for (const rec of records) {
    const status = rec.status;
    if (status === "HALFDAY") {
      paidCount += 0.5;
      lopCount += 0.5;
      halfDayCount++;
    } else {
      if (PAID_STATUSES.includes(status)) paidCount++;
      if (LOP_STATUSES.includes(status)) lopCount++;
    }
    if (status === "HOLIDAY_WORK") holidayWorkCount++;
  }

  const leaveLopSum = leaveRows.reduce((acc, row) => acc + parseFloat(row.lopDays ?? "0"), 0);
  const totalLopDays = lopCount + leaveLopSum;

  return {
    userId,
    scheduledDays: String(totalDays),
    paidDays: String(paidCount),
    lopDays: totalLopDays.toFixed(1),
    halfDays: String(halfDayCount),
    overtimeHours: "0",
    shiftAllowanceUnits: "0",
    holidayWorkDays: String(holidayWorkCount),
    billableHours: "0",
    source: "ATTENDANCE",
  };
}

export async function loadLiveAttendanceByUser(
  db: Db,
  orgId: string,
  userIds: string[],
  month: string,
): Promise<Map<string, PulledInputs | null>> {
  const result = new Map<string, PulledInputs | null>();
  if (userIds.length === 0) return result;

  const monthStart = `${month}-01`;
  const totalDays = daysInMonth(month);
  const monthEnd = `${month}-${String(totalDays).padStart(2, "0")}`;

  const [attendanceRows, leaveRowsAll] = await Promise.all([
    db
      .select({ userId: attendance.userId, status: attendance.status })
      .from(attendance)
      .where(
        and(
          eq(attendance.orgId, orgId),
          inArray(attendance.userId, userIds),
          gte(attendance.date, monthStart),
          lte(attendance.date, monthEnd),
        ),
      )
      .limit(Math.max(1, userIds.length * totalDays)),
    db
      .select({ userId: leaveRequests.userId, lopDays: leaveRequests.lopDays })
      .from(leaveRequests)
      .where(
        and(
          eq(leaveRequests.orgId, orgId),
          inArray(leaveRequests.userId, userIds),
          eq(leaveRequests.status, "APPROVED"),
          gte(leaveRequests.startDate, monthStart),
          lte(leaveRequests.endDate, monthEnd),
        ),
      )
      .limit(Math.max(1, userIds.length * totalDays * 2)),
  ]);

  const attendanceByUser = new Map<string, LiveAttendanceRow[]>();
  for (const row of attendanceRows) {
    const list = attendanceByUser.get(row.userId) ?? [];
    list.push(row);
    attendanceByUser.set(row.userId, list);
  }

  const leavesByUser = new Map<string, LiveLeaveRow[]>();
  for (const row of leaveRowsAll) {
    const list = leavesByUser.get(row.userId) ?? [];
    list.push(row);
    leavesByUser.set(row.userId, list);
  }

  for (const userId of userIds) {
    result.set(
      userId,
      buildLiveAttendanceInputs(
        userId,
        month,
        attendanceByUser.get(userId) ?? [],
        leavesByUser.get(userId) ?? [],
      ),
    );
  }
  return result;
}
