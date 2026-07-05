import { and, eq, gte, lte, inArray, sum } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import { attendance, leaveRequests } from "../../../../db/schema";
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
  source: "ATTENDANCE" | "LEAVE" | "MANUAL";
}

const PAID_STATUSES = ["PRESENT", "WFH", "HALFDAY", "HOLIDAY_WORK"];
const LOP_STATUSES = ["ABSENT", "LEAVE_WITHOUT_PAY"];

export async function pullAttendanceInputs(
  db: Db,
  orgId: string,
  userId: string,
  month: string,
): Promise<PulledInputs | null> {
  const monthStart = `${month}-01`;
  const totalDays = daysInMonth(month);
  const monthEnd = `${month}-${String(totalDays).padStart(2, "0")}`;

  const records = await db
    .select({
      status: attendance.status,
    })
    .from(attendance)
    .where(
      and(
        eq(attendance.orgId, orgId),
        eq(attendance.userId, userId),
        gte(attendance.date, monthStart),
        lte(attendance.date, monthEnd),
      ),
    );

  if (records.length === 0) {
    return null;
  }

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

  const leaveRows = await db
    .select({ lopDays: leaveRequests.lopDays })
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.orgId, orgId),
        eq(leaveRequests.userId, userId),
        eq(leaveRequests.status, "APPROVED"),
        gte(leaveRequests.startDate, monthStart),
        lte(leaveRequests.endDate, monthEnd),
      ),
    );

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
