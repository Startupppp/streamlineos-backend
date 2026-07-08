export interface QuietHoursConfig {
  start: string | null;
  end: string | null;
  timezone: string;
  includeWeekends: boolean;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

export function parseHhMm(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function zonedNow(date: Date, timeZone: string): { minutes: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone || "UTC",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0;
  const minute = Number(get("minute"));
  return { minutes: hour * 60 + minute, weekday: WEEKDAY_INDEX[get("weekday")] ?? 0 };
}

export function isWithinQuietHours(now: Date, cfg: QuietHoursConfig): boolean {
  const start = parseHhMm(cfg.start);
  const end = parseHhMm(cfg.end);
  if (start === null || end === null || start === end) return false;

  const { minutes, weekday } = zonedNow(now, cfg.timezone);
  const isWeekend = weekday === 0 || weekday === 6;
  if (isWeekend && !cfg.includeWeekends) return false;

  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

export function quietHoursEndAt(now: Date, cfg: QuietHoursConfig): Date | null {
  const end = parseHhMm(cfg.end);
  if (end === null) return null;
  const { minutes } = zonedNow(now, cfg.timezone);
  let deltaMinutes = end - minutes;
  if (deltaMinutes <= 0) deltaMinutes += 24 * 60;
  return new Date(now.getTime() + deltaMinutes * 60_000);
}
