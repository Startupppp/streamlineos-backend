export function formatDateOnly(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function weekRange(
  date: Date,
  workWeekStart: number,
): { start: string; end: string } {
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day - workWeekStart + 7) % 7;
  const start = new Date(d);
  start.setDate(d.getDate() - diff);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return { start: formatDateOnly(start), end: formatDateOnly(end) };
}

/**
 * Whole days from `from` to `to`, both `YYYY-MM-DD`. Negative when `to` is earlier.
 *
 * Both endpoints are parsed the same way, as UTC midnight, which is the whole
 * point. The backdate check used to compare `new Date(today)` — UTC midnight —
 * against `new Date(input.date + "T12:00:00")` — LOCAL noon. Mixing the two
 * builds a half-day cushion into the subtraction that `Math.floor` then
 * swallows, and the size of the cushion depends on the server's offset. The
 * result was that `backdateLimitDays: 3` allowed three days in UTC+14 and four
 * in UTC or India: the same setting meaning different things on different
 * machines.
 */
export function wholeDaysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) throw new Error(`not a date: ${from} / ${to}`);
  return Math.round((b - a) / 86_400_000);
}
