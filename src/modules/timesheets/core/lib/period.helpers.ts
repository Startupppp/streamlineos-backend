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

export function wholeDaysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) throw new Error(`not a date: ${from} / ${to}`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * The calendar day of an instant in UTC.
 *
 * "Today" must never be derived from the host timezone. `formatDateOnly` reads
 * local calendar fields, so at 23:00 UTC on 2026-10-03 a UTC server calls it
 * 2026-10-03 while an Asia/Kolkata server calls it 2026-10-04 — the same
 * instant, a different day, and therefore a different backdate verdict for the
 * same request. Use this for every "what day is it" decision.
 */
export function utcDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}
