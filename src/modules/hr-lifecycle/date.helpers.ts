const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatDdMmmYyyy(input: Date | string): string {
  const d = new Date(input);
  return `${pad(d.getDate())} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

export function formatDdMmmYyyyTime(input: Date | string): string {
  const d = new Date(input);
  return `${pad(d.getDate())} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDdMmYyyy(input: Date | string): string {
  const d = new Date(input);
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
}

export function formatLongInIN(input: Date | string): string {
  return new Date(input).toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" });
}

export function subMonths(input: Date, months: number): Date {
  const d = new Date(input);
  d.setMonth(d.getMonth() - months);
  return d;
}
