const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function formatDateOnly(value: Date | string | null | undefined): string {
  if (!value) return "";
  let date: Date;
  if (typeof value === "string") {
    if (DATE_ONLY.test(value)) return value;
    date = new Date(value);
  } else {
    date = value;
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}
