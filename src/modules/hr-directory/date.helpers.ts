const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export function formatDateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function startOfDay(date: Date): Date {
  const result = new Date(date.getTime());
  result.setHours(0, 0, 0, 0);
  return result;
}

export function addYears(date: Date, amount: number): Date {
  const result = new Date(date.getTime());
  result.setFullYear(result.getFullYear() + amount);
  return result;
}

export function subDays(date: Date, amount: number): Date {
  const result = new Date(date.getTime());
  result.setDate(result.getDate() - amount);
  return result;
}

export function differenceInDays(later: Date, earlier: Date): number {
  const ms = startOfDay(later).getTime() - startOfDay(earlier).getTime();
  return Math.round(ms / 86_400_000);
}

export function formatMonthDay(date: Date): string {
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

export function formatDayMonthYear(date: Date): string {
  const day = String(date.getDate()).padStart(2, "0");
  return `${day} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

export function formatDayMonthYearTime(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${formatDayMonthYear(date)} ${hours}:${minutes}`;
}
