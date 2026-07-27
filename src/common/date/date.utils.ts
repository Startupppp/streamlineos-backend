// ─── Format helpers ───────────────────────────────────────────────────────────

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatDateOnly(value: Date | string | null | undefined): string {
  if (!value) return "";
  let date: Date;
  if (typeof value === "string") {
    if (DATE_ONLY_RE.test(value)) return value;
    date = new Date(value);
  } else {
    date = value;
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function getTodayString(): string {
  return formatDateOnly(new Date());
}

export function formatDdMmmYyyy(input: Date | string): string {
  const d = new Date(input);
  return `${pad(d.getDate())} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

export function formatDdMmmYyyyTime(input: Date | string): string {
  const d = new Date(input);
  return `${pad(d.getDate())} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatLongInIN(input: Date | string): string {
  return new Date(input).toLocaleDateString("en-IN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function formatMonthDay(date: Date): string {
  return `${MONTHS_SHORT[date.getMonth()]} ${date.getDate()}`;
}

export function formatDayMonthYear(date: Date): string {
  return `${pad(date.getDate())} ${MONTHS_SHORT[date.getMonth()]} ${date.getFullYear()}`;
}

export function formatDayMonthYearTime(date: Date): string {
  return `${formatDayMonthYear(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Alias kept for hr-interviews/ics.util.ts which imports this name directly.
export { formatDateOnly as formatLocalDate };

// ─── Arithmetic helpers ────────────────────────────────────────────────────────

export function addDays(date: Date, amount: number): Date {
  const result = new Date(date.getTime());
  result.setDate(result.getDate() + amount);
  return result;
}

export function subDays(date: Date, amount: number): Date {
  const result = new Date(date.getTime());
  result.setDate(result.getDate() - amount);
  return result;
}

export function addYears(date: Date, amount: number): Date {
  const result = new Date(date.getTime());
  result.setFullYear(result.getFullYear() + amount);
  return result;
}

/**
 * Month-boundary-correct subMonths: clamps to the last calendar day of the
 * target month instead of overflowing (e.g. Mar 31 - 1 month → Feb 28/29,
 * not Mar 3). Canonical source: modules/sales/date.helpers.ts.
 *
 * BEHAVIOR RECONCILIATION: modules/hr-lifecycle/date.helpers.ts used a plain
 * `setMonth(month - n)` which overflows on month-end dates. This implementation
 * replaces that with the correct clamped version from sales/date.helpers.ts.
 */
export function subMonths(date: Date, amount: number): Date {
  const targetDay = date.getDate();
  const first = new Date(date.getTime());
  first.setDate(1);
  first.setMonth(first.getMonth() - amount);
  const daysInTarget = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  first.setDate(Math.min(targetDay, daysInTarget));
  return first;
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

// ─── Boundary helpers ──────────────────────────────────────────────────────────

export function startOfDay(date: Date): Date {
  const result = new Date(date.getTime());
  result.setHours(0, 0, 0, 0);
  return result;
}

export function endOfDay(date: Date): Date {
  const result = new Date(date.getTime());
  result.setHours(23, 59, 59, 999);
  return result;
}

export function startOfMonth(date: Date): Date {
  const result = new Date(date.getTime());
  result.setDate(1);
  result.setHours(0, 0, 0, 0);
  return result;
}

export function endOfMonth(date: Date): Date {
  const result = new Date(date.getTime());
  result.setMonth(result.getMonth() + 1, 0);
  result.setHours(23, 59, 59, 999);
  return result;
}

// ─── Difference helpers ────────────────────────────────────────────────────────

export function differenceInCalendarDays(later: Date, earlier: Date): number {
  const a = new Date(later.getFullYear(), later.getMonth(), later.getDate());
  const b = new Date(earlier.getFullYear(), earlier.getMonth(), earlier.getDate());
  return Math.round((a.getTime() - b.getTime()) / 86_400_000);
}

export function differenceInDays(later: Date, earlier: Date): number {
  return Math.round(
    (startOfDay(later).getTime() - startOfDay(earlier).getTime()) / 86_400_000,
  );
}
