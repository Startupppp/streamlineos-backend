import { RRule } from "rrule";
import { formatInTimeZone, toZonedTime, fromZonedTime } from "date-fns-tz";
import {
  expandToOccurrences,
  toWallClockUtc,
  fromWallClockUtc,
  type CalendarEventLike,
} from "./calendar-occurrence.service";

/**
 * Recurrence expansion must not depend on the timezone the Node process runs
 * in. `rrule` reads a `dtstart`'s UTC getters as the wall clock; date-fns-tz's
 * `toZonedTime` produces the system-local representation instead. The two agree
 * only at TZ=UTC, so off UTC every occurrence was rotated by the host's offset
 * before BYDAY/BYMONTHDAY were applied and landed on the wrong DAY.
 *
 * Nothing in this repo pins TZ — not `src/test/jest-setup.ts`, not the jest
 * block in package.json — so the suite inherits the host's zone and the old
 * code was green on a UTC runner while wrong in any non-UTC deployment.
 */

const NY = "America/New_York";
const HOST_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

function series(startUtcIso: string, rrule: string, timezone = NY): CalendarEventLike {
  return {
    id: 1,
    title: "series",
    startDate: new Date(startUtcIso),
    endDate: new Date(new Date(startUtcIso).getTime() + 30 * 60_000),
    allDay: false,
    timezone,
    orgId: "org-tz",
    rrule,
    recurrenceEnd: null,
  };
}

function startsOf(event: CalendarEventLike, fromIso: string, toIso: string): string[] {
  return expandToOccurrences(event, new Date(fromIso), new Date(toIso)).map((o) =>
    o.startDate.toISOString(),
  );
}

type HostOffset = (instant: Date) => number;

const fixedHost = (hours: number): HostOffset => () => hours * 3_600_000;
const ambientHost: HostOffset = (instant) => -instant.getTimezoneOffset() * 60_000;

/**
 * The mechanism the service used before the fix, with the host's contribution
 * made an explicit parameter instead of ambient. `toZonedTime(i, tz)` returns a
 * Date whose SYSTEM-LOCAL fields read as the wall clock, which is
 * `wallClock(i, tz) - hostOffset`; `fromZonedTime` inverts it. Passing 0
 * reproduces a UTC host, and any other value reproduces that host — which is
 * what lets these cases bite under EVERY host zone. Guarding on the ambient
 * zone instead made them pass vacuously under TZ=America/New_York.
 */
function expandTheOldWay(
  event: CalendarEventLike,
  fromIso: string,
  toIso: string,
  hostOffsetAt: HostOffset,
): string[] {
  const zone = event.timezone;
  const asHostSees = (instant: Date): Date =>
    new Date(toWallClockUtc(instant, zone).getTime() - hostOffsetAt(instant));
  const backToInstant = (seen: Date): Date => {
    const seed = fromWallClockUtc(new Date(seen.getTime() + hostOffsetAt(seen)), zone);
    return fromWallClockUtc(new Date(seen.getTime() + hostOffsetAt(seed)), zone);
  };

  const rule = RRule.fromString(event.rrule!);
  const expanded = new RRule({ ...rule.origOptions, dtstart: asHostSees(event.startDate) });
  return expanded
    .between(asHostSees(new Date(fromIso)), asHostSees(new Date(toIso)), true)
    .map((d) => backToInstant(d).toISOString());
}

/** The real ambient old code, for the replica to be checked against. */
function expandTheOldWayAmbient(
  event: CalendarEventLike,
  fromIso: string,
  toIso: string,
): string[] {
  const rule = RRule.fromString(event.rrule!);
  const expanded = new RRule({
    ...rule.origOptions,
    dtstart: toZonedTime(event.startDate, event.timezone),
  });
  return expanded
    .between(
      toZonedTime(new Date(fromIso), event.timezone),
      toZonedTime(new Date(toIso), event.timezone),
      true,
    )
    .map((d) => fromZonedTime(d, event.timezone).toISOString());
}

const weekdaysIn = (isos: string[], zone = NY): string[] =>
  isos.map((iso) => formatInTimeZone(new Date(iso), zone, "EEEE"));

describe("wall-clock conversion helpers do not consult the host timezone", () => {
  const instants = [
    "2024-01-15T12:00:00Z",
    "2024-03-10T06:30:00Z",
    "2024-07-04T23:45:00Z",
    "2024-11-03T05:30:00Z",
  ];
  const zones = [NY, "Asia/Kolkata", "Europe/Berlin", "Pacific/Auckland", "UTC"];

  it("toWallClockUtc's UTC fields equal what the zone's own formatter prints", () => {
    for (const zone of zones) {
      for (const iso of instants) {
        const instant = new Date(iso);
        expect(toWallClockUtc(instant, zone).toISOString().slice(0, 16)).toBe(
          formatInTimeZone(instant, zone, "yyyy-MM-dd'T'HH:mm"),
        );
      }
    }
  });

  it("is accurate to the INSTANT inside a transition day, where getTimezoneOffset is not", () => {
    const beforeSpringForward = new Date("2024-03-10T06:30:00Z");
    expect(toWallClockUtc(beforeSpringForward, NY).toISOString().slice(0, 16)).toBe(
      "2024-03-10T01:30",
    );
    const afterSpringForward = new Date("2024-03-10T07:30:00Z");
    expect(toWallClockUtc(afterSpringForward, NY).toISOString().slice(0, 16)).toBe(
      "2024-03-10T03:30",
    );
  });

  it("fromWallClockUtc inverts toWallClockUtc exactly", () => {
    for (const zone of zones) {
      for (const iso of instants) {
        const instant = new Date(iso);
        expect(fromWallClockUtc(toWallClockUtc(instant, zone), zone).getTime()).toBe(
          instant.getTime(),
        );
      }
    }
  });
});

describe("recurrence expansion lands on the right DAY regardless of host timezone", () => {
  it("an all-day weekly Monday series stays on Mondays (00:00 America/New_York)", () => {
    const event = series("2024-03-04T05:00:00Z", "FREQ=WEEKLY;BYDAY=MO");
    expect(startsOf(event, "2024-03-01T00:00:00Z", "2024-03-25T00:00:00Z")).toEqual([
      "2024-03-04T05:00:00.000Z",
      "2024-03-11T04:00:00.000Z",
      "2024-03-18T04:00:00.000Z",
    ]);
  });

  it("a monthly BYMONTHDAY=1 series at midnight stays on the 1st, not the 2nd", () => {
    const event = series("2024-04-01T04:00:00Z", "FREQ=MONTHLY;BYMONTHDAY=1");
    expect(startsOf(event, "2024-03-25T00:00:00Z", "2024-06-15T00:00:00Z")).toEqual([
      "2024-04-01T04:00:00.000Z",
      "2024-05-01T04:00:00.000Z",
      "2024-06-01T04:00:00.000Z",
    ]);
  });

  it("an early-morning (04:00) weekly Friday series stays on Fridays", () => {
    const event = series("2024-06-07T08:00:00Z", "FREQ=WEEKLY;BYDAY=FR");
    const starts = startsOf(event, "2024-06-01T00:00:00Z", "2024-06-22T00:00:00Z");
    expect(starts).toEqual([
      "2024-06-07T08:00:00.000Z",
      "2024-06-14T08:00:00.000Z",
      "2024-06-21T08:00:00.000Z",
    ]);
    for (const iso of starts)
      expect(formatInTimeZone(new Date(iso), NY, "EEEE HH:mm")).toBe("Friday 04:00");
  });

  it("a late-evening (22:00) weekly Friday series stays on Fridays", () => {
    const event = series("2024-06-08T02:00:00Z", "FREQ=WEEKLY;BYDAY=FR");
    const starts = startsOf(event, "2024-06-01T00:00:00Z", "2024-06-23T00:00:00Z");
    expect(starts).toHaveLength(3);
    for (const iso of starts)
      expect(formatInTimeZone(new Date(iso), NY, "EEEE HH:mm")).toBe("Friday 22:00");
  });

  it("an all-day weekly series keeps its weekday across the fall-back transition", () => {
    const event = series("2024-10-28T04:00:00Z", "FREQ=WEEKLY;BYDAY=MO");
    const starts = startsOf(event, "2024-10-25T00:00:00Z", "2024-11-20T00:00:00Z");
    expect(starts).toEqual([
      "2024-10-28T04:00:00.000Z",
      "2024-11-04T05:00:00.000Z",
      "2024-11-11T05:00:00.000Z",
      "2024-11-18T05:00:00.000Z",
    ]);
    for (const iso of starts)
      expect(formatInTimeZone(new Date(iso), NY, "EEEE HH:mm")).toBe("Monday 00:00");
  });

  it("a midday series is unaffected — the control that stayed green before the fix", () => {
    const event = series("2024-03-04T14:00:00Z", "FREQ=WEEKLY;BYDAY=MO");
    expect(startsOf(event, "2024-03-01T00:00:00Z", "2024-03-25T00:00:00Z")).toEqual([
      "2024-03-04T14:00:00.000Z",
      "2024-03-11T13:00:00.000Z",
      "2024-03-18T13:00:00.000Z",
    ]);
  });

  it("a positive-offset zone (Asia/Kolkata) all-day weekly series keeps its weekday", () => {
    const event = series("2024-03-03T18:30:00Z", "FREQ=WEEKLY;BYDAY=MO", "Asia/Kolkata");
    const starts = startsOf(event, "2024-03-01T00:00:00Z", "2024-03-20T00:00:00Z");
    expect(starts).toHaveLength(3);
    for (const iso of starts)
      expect(formatInTimeZone(new Date(iso), "Asia/Kolkata", "EEEE HH:mm")).toBe("Monday 00:00");
  });
});

describe("BITE — the old mechanism produced these same wrong days", () => {
  const MIDNIGHT_MONDAY = "2024-03-04T05:00:00Z";
  const FROM = "2024-03-01T00:00:00Z";
  const TO = "2024-03-25T00:00:00Z";

  it("the parameterised replica reproduces the real ambient old code on this host", () => {
    const event = series(MIDNIGHT_MONDAY, "FREQ=WEEKLY;BYDAY=MO");
    expect(expandTheOldWay(event, FROM, TO, ambientHost)).toEqual(
      expandTheOldWayAmbient(event, FROM, TO),
    );
  });

  it("a UTC host hid the defect: at hostOffset 0 the old mechanism agreed with the fix", () => {
    const event = series(MIDNIGHT_MONDAY, "FREQ=WEEKLY;BYDAY=MO");
    expect(expandTheOldWay(event, FROM, TO, fixedHost(0))).toEqual(startsOf(event, FROM, TO));
  });

  it("a POSITIVE host offset rolled the midnight series off Monday", () => {
    const event = series(MIDNIGHT_MONDAY, "FREQ=WEEKLY;BYDAY=MO");
    const fixed = startsOf(event, FROM, TO);
    expect(weekdaysIn(fixed)).toEqual(["Monday", "Monday", "Monday"]);

    for (const hours of [5.5, 1, 9, 12]) {
      const old = expandTheOldWay(event, FROM, TO, fixedHost(hours));
      expect(old).not.toEqual(fixed);
      expect(weekdaysIn(old).includes("Monday")).toBe(false);
    }
  });

  it("at the +05:30 offset of an India-hosted server the old mechanism reported Tuesday", () => {
    const event = series(MIDNIGHT_MONDAY, "FREQ=WEEKLY;BYDAY=MO");
    const old = expandTheOldWay(event, FROM, TO, fixedHost(5.5));
    expect(weekdaysIn(old)).toEqual(["Tuesday", "Tuesday", "Tuesday"]);
  });

  it("a NEGATIVE host offset left midnight alone but rolled a late-evening series off Friday", () => {
    const midnight = series(MIDNIGHT_MONDAY, "FREQ=WEEKLY;BYDAY=MO");
    expect(weekdaysIn(expandTheOldWay(midnight, FROM, TO, fixedHost(-8)))).toEqual([
      "Monday",
      "Monday",
      "Monday",
    ]);

    const evening = series("2024-06-08T02:00:00Z", "FREQ=WEEKLY;BYDAY=FR");
    const from = "2024-06-01T00:00:00Z";
    const to = "2024-06-23T00:00:00Z";
    expect(weekdaysIn(startsOf(evening, from, to))).toEqual(["Friday", "Friday", "Friday"]);
    for (const hours of [-8, -5, -3]) {
      const old = expandTheOldWay(evening, from, to, fixedHost(hours));
      expect(weekdaysIn(old).includes("Friday")).toBe(false);
    }
  });

  it("a monthly BYMONTHDAY=1 series left the 1st at a positive host offset", () => {
    const event = series("2024-04-01T04:00:00Z", "FREQ=MONTHLY;BYMONTHDAY=1");
    const from = "2024-03-25T00:00:00Z";
    const to = "2024-06-15T00:00:00Z";
    const fixed = startsOf(event, from, to);
    for (const iso of fixed) expect(formatInTimeZone(new Date(iso), NY, "d")).toBe("1");

    expect(expandTheOldWay(event, from, to, fixedHost(0))).toEqual(fixed);
    for (const hours of [5.5, 2, 11]) {
      const old = expandTheOldWay(event, from, to, fixedHost(hours));
      expect(old.every((iso) => formatInTimeZone(new Date(iso), NY, "d") === "1")).toBe(false);
    }
  });

  it("names the host zone this run actually exercised, so a green result is attributable", () => {
    expect(typeof HOST_TZ).toBe("string");
    expect(HOST_TZ.length).toBeGreaterThan(0);
  });
});
