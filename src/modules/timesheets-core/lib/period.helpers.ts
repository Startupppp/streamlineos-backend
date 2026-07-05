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
