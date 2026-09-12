import { toWallClockUtc } from "../../common/date/zoned-wall-clock";

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

export function formatDate(date: Date, timezone: string | null): string {
  const wall = toWallClockUtc(date, timezone ?? "UTC");
  return `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}`;
}

export function formatDatetime(date: Date, timezone: string | null): string {
  const wall = toWallClockUtc(date, timezone ?? "UTC");
  return `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())} ${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}`;
}

const FORMULA_LEAD_RE = /^[=+\-@\t\r]/;

export function csvEscape(value: string): string {
  const safe = FORMULA_LEAD_RE.test(value) ? `'${value}` : value;
  if (/[",\n\r]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}
