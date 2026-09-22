import { formatDateOnly, weekRange } from "./period.helpers";

export function lastCompleteWeekRange(
  today: Date,
  workWeekStart: number,
): { start: string; end: string } {
  const current = weekRange(today, workWeekStart);
  const previous = new Date(`${current.start}T12:00:00`);
  previous.setDate(previous.getDate() - 7);
  return weekRange(previous, workWeekStart);
}

export function addDays(dateOnly: string, days: number): string {
  const d = new Date(`${dateOnly}T12:00:00`);
  d.setDate(d.getDate() + days);
  return formatDateOnly(d);
}
