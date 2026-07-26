import { formatDateOnly, weekRange } from "./period.helpers";

/**
 * The most recent fully elapsed work week: the week immediately before the
 * one containing `today`, honouring the org's configured work-week start.
 */
export function lastCompleteWeekRange(
  today: Date,
  workWeekStart: number,
): { start: string; end: string } {
  const current = weekRange(today, workWeekStart);
  const previous = new Date(`${current.start}T12:00:00`);
  previous.setDate(previous.getDate() - 7);
  return weekRange(previous, workWeekStart);
}

/** Add (or subtract) whole days to a YYYY-MM-DD date string. */
export function addDays(dateOnly: string, days: number): string {
  const d = new Date(`${dateOnly}T12:00:00`);
  d.setDate(d.getDate() + days);
  return formatDateOnly(d);
}
