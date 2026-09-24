export const AUTO_PRESENCE_STATUSES = ["ONLINE", "AWAY", "OFFLINE"] as const;

export const MANUAL_PRESENCE_STATUSES = [
  "BUSY",
  "DO_NOT_DISTURB",
  "IN_A_MEETING",
  "ON_LEAVE",
  "VACATION",
  "WORKING_REMOTELY",
] as const;

export const PRESENCE_STATUSES = [
  ...AUTO_PRESENCE_STATUSES,
  ...MANUAL_PRESENCE_STATUSES,
] as const;

export type PresenceStatus = (typeof PRESENCE_STATUSES)[number];
export type AutoPresenceStatus = (typeof AUTO_PRESENCE_STATUSES)[number];

export const ACTIVE_PRESENCE_STATUS: AutoPresenceStatus = "ONLINE";

export function isAutoPresenceStatus(value: string): value is AutoPresenceStatus {
  return AUTO_PRESENCE_STATUSES.some((s) => s === value);
}

export const PRESENCE_CLEAR_AFTER_OPTIONS = ["1h", "today", "week", "never"] as const;

export type PresenceClearAfter = (typeof PRESENCE_CLEAR_AFTER_OPTIONS)[number];

export const PRESENCE_STATUS_MESSAGE_MAX_LENGTH = 100;

const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;

const PRESENCE_EXPIRY_BY_CLEAR_AFTER: Record<
  PresenceClearAfter,
  (from: Date) => Date | null
> = {
  "1h": (from) => new Date(from.getTime() + HOUR_MS),
  today: (from) => {
    const endOfUtcDay = new Date(from);
    endOfUtcDay.setUTCHours(23, 59, 59, 999);
    return endOfUtcDay;
  },
  week: (from) => new Date(from.getTime() + WEEK_MS),
  never: () => null,
};

export function presenceStatusExpiry(
  clearAfter: PresenceClearAfter,
  from: Date,
): Date | null {
  return PRESENCE_EXPIRY_BY_CLEAR_AFTER[clearAfter](from);
}
