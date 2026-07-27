export function formatDateOnly(date: Date | string | null | undefined): string {
  if (!date) return "";
  let resolved: Date;
  if (typeof date === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
    resolved = new Date(date);
  } else {
    resolved = date;
  }
  const year = resolved.getFullYear();
  const month = String(resolved.getMonth() + 1).padStart(2, "0");
  const day = String(resolved.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addDays(date: Date, amount: number): Date {
  const result = new Date(date.getTime());
  result.setDate(result.getDate() + amount);
  return result;
}

export function differenceInCalendarDays(dateLeft: Date, dateRight: Date): number {
  const startLeft = new Date(dateLeft.getFullYear(), dateLeft.getMonth(), dateLeft.getDate());
  const startRight = new Date(dateRight.getFullYear(), dateRight.getMonth(), dateRight.getDate());
  return Math.round((startLeft.getTime() - startRight.getTime()) / 86400000);
}
