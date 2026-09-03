/**
 * A Date whose UTC fields ARE a named zone's wall clock, and back.
 *
 * Calendar arithmetic in a named zone has to happen on fields that do not move:
 * `getHours()`/`setHours()` read and write the HOST's zone, so on the host's own
 * DST-transition day a wall clock the target zone has can be unrepresentable
 * locally and JavaScript silently normalises it — 02:30 becomes 03:30 and the
 * hour is skipped. `getUTC*`/`setUTC*` have no transitions at all, so a wall
 * clock carried in UTC fields can be walked exactly.
 *
 * `date-fns-tz`'s `toZonedTime`/`fromZonedTime` build the OTHER representation —
 * one whose system-local getters read as the wall clock — which is correct for
 * date-fns but couples every field operation to the host. That is the defect
 * d01b3c41 measured in calendar recurrence expansion.
 *
 * `getTimezoneOffset` is not a substitute: it resolves an offset per calendar
 * DAY, so it answers -04:00 for every instant of 2024-03-10 including the ones
 * before the 07:00Z transition. Only `Intl` is accurate to the instant.
 */
const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = zoneFormatters.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  zoneFormatters.set(timeZone, created);
  return created;
}

export function toWallClockUtc(instant: Date, timeZone: string): Date {
  const parts = zoneFormatter(timeZone).formatToParts(instant);
  const field = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  const hour = field("hour") % 24;
  const wall = new Date(0);
  wall.setUTCFullYear(field("year"), field("month") - 1, field("day"));
  wall.setUTCHours(hour, field("minute"), field("second"), instant.getUTCMilliseconds());
  return wall;
}

export function fromWallClockUtc(wallClock: Date, timeZone: string): Date {
  const seedOffset = toWallClockUtc(wallClock, timeZone).getTime() - wallClock.getTime();
  const seedInstant = new Date(wallClock.getTime() - seedOffset);
  const offset = toWallClockUtc(seedInstant, timeZone).getTime() - seedInstant.getTime();
  return new Date(wallClock.getTime() - offset);
}
