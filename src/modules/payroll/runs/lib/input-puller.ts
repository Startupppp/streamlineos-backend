import { and, eq, gte, inArray, lte } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import { attendance, leaveRequests } from "../../../../db/schema";
import {
  hrPayrollInputPeriods,
  hrPayrollInputSnapshots,
} from "../../../../db/schema/payroll/input-capture";
import { daysInMonth } from "./money";

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
 * Prefer immutable locked payroll-input period snapshots for the month.
 * Falls back to live attendance/leave pull when no locked period exists.
 */
export async function pullAttendanceInputs(
  db: Db,
  orgId: string,
  userId: string,
  month: string,
): Promise<PulledInputs | null> {
  const locked = await pullFromLockedSnapshots(db, orgId, userId, month);
  if (locked) return locked;
  return pullLiveAttendanceInputs(db, orgId, userId, month);
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
    })
    .from(hrPayrollInputSnapshots)
    .where(
      and(
        eq(hrPayrollInputSnapshots.orgId, orgId),
        eq(hrPayrollInputSnapshots.periodId, periodId),
        inArray(hrPayrollInputSnapshots.userId, userIds),
      ),
    );

  for (const snap of snaps) {
    if (!snap.payload || typeof snap.payload !== "object") continue;
    const sections = byUser.get(snap.userId) ?? new Map<string, SnapshotPayload>();
    sections.set(snap.section, snap.payload as SnapshotPayload);
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

export type LockedCalcPulls = {
  fromLockedSnapshot: true;
  approvedReimbursements: { amount: string; category: string }[];
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
};

export function buildCalcPullsFromSections(
  bySection: SectionMap | undefined,
): LockedCalcPulls | null {
  if (!bySection || bySection.size === 0) return null;

  const reimb = bySection.get("reimbursement") ?? {};
  const deduction = bySection.get("deduction") ?? {};
  const overtime = bySection.get("overtime") ?? {};
  const attendanceSection = bySection.get("attendance") ?? {};

  const items = Array.isArray(reimb.items) ? reimb.items : [];
  const approvedReimbursements: { amount: string; category: string }[] = [];
  const consumedReimbursementIds: number[] = [];

  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const amount = item.amount;
    const category = typeof item.category === "string" ? item.category : "OTHER";
    const amountStr =
      typeof amount === "number"
        ? amount.toFixed(2)
        : typeof amount === "string"
          ? amount
          : "0";
    approvedReimbursements.push({ amount: amountStr, category });
    if (typeof item.id === "number" && item.source !== "benefits_claim") {
      consumedReimbursementIds.push(item.id);
    }
  }

  const loansRaw = Array.isArray(deduction.activeLoans) ? deduction.activeLoans : [];
  const activeLoans = loansRaw
    .filter((l): l is Record<string, unknown> => !!l && typeof l === "object")
    .map((l) => ({
      id: num(l.id),
      emiAmount: l.emiAmount == null ? null : String(l.emiAmount),
      amount: String(l.amount ?? "0"),
      paidEmis: num(l.paidEmis),
      totalEmis: l.totalEmis == null ? null : num(l.totalEmis),
      adjustment: null as { type: string; amount: string | null } | null,
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
      ),
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
      ),
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

async function pullLiveAttendanceInputs(
  db: Db,
  orgId: string,
  userId: string,
  month: string,
): Promise<PulledInputs | null> {
  const byUser = await loadLiveAttendanceByUser(db, orgId, [userId], month);
  return byUser.get(userId) ?? null;
}
