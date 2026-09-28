/**
 * Pure capacity calculation — no database, no injected services.
 * All inputs are plain data; callers are responsible for fetching
 * timesheetSettings and HR leave rows before calling these functions.
 */

export interface CapacityLeaveInterval {
  startDate: string;
  endDate: string;
  isHalfDay: boolean;
}

export interface CapacityInput {
  windowStart: string;
  windowEnd: string;
  expectedDailyHours: number | null;
  loggedHours: number;
  estimateHours: number | null;
  leaves: CapacityLeaveInterval[];
}

export interface CapacityResult {
  workingDaysInWindow: number;
  leaveDays: number;
  halfLeaveDays: number;
  netCapacityDays: number;
  capacityHours: number | null;
  loggedHours: number;
  estimateHours: number | null;
  allocationPercent: number | null;
  varianceHours: number | null;
  isOverAllocated: boolean;
  isZeroCapacity: boolean;
  utilizationPercent: number | null;
}

function parseUTCDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function isWorkingDay(date: Date): boolean {
  const dow = date.getUTCDay();
  return dow >= 1 && dow <= 5;
}

export function countWorkingDays(startStr: string, endStr: string): number {
  const start = parseUTCDate(startStr);
  const end = parseUTCDate(endStr);
  if (end < start) return 0;
  let count = 0;
  const cur = new Date(start);
  while (cur <= end) {
    if (isWorkingDay(cur)) count++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return count;
}

function clipLeaveToWindow(
  leaveStart: string,
  leaveEnd: string,
  windowStart: string,
  windowEnd: string,
): { start: string; end: string } | null {
  const clippedStart = leaveStart < windowStart ? windowStart : leaveStart;
  const clippedEnd = leaveEnd > windowEnd ? windowEnd : leaveEnd;
  if (clippedStart > clippedEnd) return null;
  return { start: clippedStart, end: clippedEnd };
}

export function computeCapacity(input: CapacityInput): CapacityResult {
  const { windowStart, windowEnd, expectedDailyHours, loggedHours, estimateHours, leaves } =
    input;

  const workingDaysInWindow = countWorkingDays(windowStart, windowEnd);

  let leaveDays = 0;
  let halfLeaveDays = 0;

  for (const leave of leaves) {
    const clipped = clipLeaveToWindow(leave.startDate, leave.endDate, windowStart, windowEnd);
    if (clipped === null) continue;
    const workDays = countWorkingDays(clipped.start, clipped.end);
    if (leave.isHalfDay) {
      halfLeaveDays += workDays;
    } else {
      leaveDays += workDays;
    }
  }

  const netCapacityDays = Math.max(0, workingDaysInWindow - leaveDays - halfLeaveDays * 0.5);

  const capacityHours =
    expectedDailyHours !== null ? netCapacityDays * expectedDailyHours : null;

  const isZeroCapacity = capacityHours !== null && capacityHours <= 0;

  const isOverAllocated =
    capacityHours !== null
      ? isZeroCapacity
        ? loggedHours > 0
        : loggedHours > capacityHours
      : false;

  const utilizationPercent =
    capacityHours !== null && capacityHours > 0
      ? Math.round((loggedHours / capacityHours) * 1000) / 10
      : null;

  const allocationPercent =
    estimateHours !== null && capacityHours !== null && capacityHours > 0
      ? Math.round((estimateHours / capacityHours) * 1000) / 10
      : null;

  const varianceHours =
    estimateHours !== null ? Math.round((loggedHours - estimateHours) * 100) / 100 : null;

  return {
    workingDaysInWindow,
    leaveDays,
    halfLeaveDays,
    netCapacityDays,
    capacityHours,
    loggedHours,
    estimateHours,
    allocationPercent,
    varianceHours,
    isOverAllocated,
    isZeroCapacity,
    utilizationPercent,
  };
}
