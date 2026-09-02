import {
  eventOverlapsWindow,
  expandToOccurrences,
  type CalendarEventLike,
} from "./calendar-occurrence.service";

function makeEvent(
  overrides: Partial<CalendarEventLike> & {
    startIso: string;
    endIso: string;
  },
): CalendarEventLike {
  return {
    id: 1,
    title: "Test event",
    startDate: new Date(overrides.startIso),
    endDate: new Date(overrides.endIso),
    allDay: false,
    timezone: "UTC",
    orgId: "org-1",
    ...overrides,
  };
}

const window7 = {
  start: new Date("2024-03-01T00:00:00Z"),
  end: new Date("2024-03-08T00:00:00Z"),
};

describe("eventOverlapsWindow — timed events", () => {
  it("returns true when the event is entirely within the window", () => {
    expect(
      eventOverlapsWindow(
        new Date("2024-03-02T10:00:00Z"),
        new Date("2024-03-02T11:00:00Z"),
        false,
        window7.start,
        window7.end,
      ),
    ).toBe(true);
  });

  it("returns true when the event starts before and ends inside the window", () => {
    expect(
      eventOverlapsWindow(
        new Date("2024-02-28T22:00:00Z"),
        new Date("2024-03-01T02:00:00Z"),
        false,
        window7.start,
        window7.end,
      ),
    ).toBe(true);
  });

  it("returns true when the event starts inside and ends after the window", () => {
    expect(
      eventOverlapsWindow(
        new Date("2024-03-07T22:00:00Z"),
        new Date("2024-03-09T00:00:00Z"),
        false,
        window7.start,
        window7.end,
      ),
    ).toBe(true);
  });

  it("returns true when the event spans the entire window", () => {
    expect(
      eventOverlapsWindow(
        new Date("2024-02-01T00:00:00Z"),
        new Date("2024-04-01T00:00:00Z"),
        false,
        window7.start,
        window7.end,
      ),
    ).toBe(true);
  });

  it("returns false when the event ends exactly at the window start (touching, not overlapping)", () => {
    expect(
      eventOverlapsWindow(
        new Date("2024-02-28T00:00:00Z"),
        window7.start,
        false,
        window7.start,
        window7.end,
      ),
    ).toBe(false);
  });

  it("returns false when the event starts exactly at the window end (touching, not overlapping)", () => {
    expect(
      eventOverlapsWindow(
        window7.end,
        new Date("2024-03-09T00:00:00Z"),
        false,
        window7.start,
        window7.end,
      ),
    ).toBe(false);
  });

  it("returns false when the event is entirely before the window", () => {
    expect(
      eventOverlapsWindow(
        new Date("2024-02-01T00:00:00Z"),
        new Date("2024-02-15T00:00:00Z"),
        false,
        window7.start,
        window7.end,
      ),
    ).toBe(false);
  });

  it("returns false when the event is entirely after the window", () => {
    expect(
      eventOverlapsWindow(
        new Date("2024-03-15T00:00:00Z"),
        new Date("2024-03-16T00:00:00Z"),
        false,
        window7.start,
        window7.end,
      ),
    ).toBe(false);
  });
});

describe("eventOverlapsWindow — DST correctness (America/New_York)", () => {
  const springForwardWindow = {
    start: new Date("2024-03-10T04:00:00Z"),
    end: new Date("2024-03-10T08:00:00Z"),
  };

  it("spring-forward: event spanning the DST gap is captured", () => {
    expect(
      eventOverlapsWindow(
        new Date("2024-03-10T06:59:00Z"),
        new Date("2024-03-10T07:30:00Z"),
        false,
        springForwardWindow.start,
        springForwardWindow.end,
      ),
    ).toBe(true);
  });

  it("spring-forward: event before the gap is not included", () => {
    expect(
      eventOverlapsWindow(
        new Date("2024-03-10T00:00:00Z"),
        new Date("2024-03-10T04:00:00Z"),
        false,
        springForwardWindow.start,
        springForwardWindow.end,
      ),
    ).toBe(false);
  });

  const fallBackWindow = {
    start: new Date("2024-11-03T04:00:00Z"),
    end: new Date("2024-11-03T08:00:00Z"),
  };

  it("fall-back: both UTC 05:59 and UTC 06:01 (the repeated hour) overlap the same window", () => {
    expect(
      eventOverlapsWindow(
        new Date("2024-11-03T05:59:00Z"),
        new Date("2024-11-03T06:30:00Z"),
        false,
        fallBackWindow.start,
        fallBackWindow.end,
      ),
    ).toBe(true);
    expect(
      eventOverlapsWindow(
        new Date("2024-11-03T06:01:00Z"),
        new Date("2024-11-03T07:00:00Z"),
        false,
        fallBackWindow.start,
        fallBackWindow.end,
      ),
    ).toBe(true);
  });
});

describe("eventOverlapsWindow — all-day events use UTC date strings", () => {
  const dateWindow = {
    start: new Date("2024-03-10T00:00:00Z"),
    end: new Date("2024-03-15T00:00:00Z"),
  };

  it("all-day event on 2024-03-12 overlaps the window", () => {
    expect(
      eventOverlapsWindow(
        new Date("2024-03-12T00:00:00Z"),
        new Date("2024-03-13T00:00:00Z"),
        true,
        dateWindow.start,
        dateWindow.end,
      ),
    ).toBe(true);
  });

  it("all-day event starting before and ending inside the window overlaps", () => {
    expect(
      eventOverlapsWindow(
        new Date("2024-03-08T00:00:00Z"),
        new Date("2024-03-11T00:00:00Z"),
        true,
        dateWindow.start,
        dateWindow.end,
      ),
    ).toBe(true);
  });

  it("all-day event ending on the window-start date does not overlap (exclusive boundary)", () => {
    expect(
      eventOverlapsWindow(
        new Date("2024-03-08T00:00:00Z"),
        new Date("2024-03-10T00:00:00Z"),
        true,
        dateWindow.start,
        dateWindow.end,
      ),
    ).toBe(false);
  });

  it("all-day event starting on the window-end date does not overlap (exclusive boundary)", () => {
    expect(
      eventOverlapsWindow(
        new Date("2024-03-15T00:00:00Z"),
        new Date("2024-03-16T00:00:00Z"),
        true,
        dateWindow.start,
        dateWindow.end,
      ),
    ).toBe(false);
  });

  it("all-day events use date strings and do not shift across zones", () => {
    const kolkataOffset = 5.5 * 60 * 60 * 1000;
    const startLocal = new Date("2024-03-12T00:00:00Z");
    const endLocal = new Date("2024-03-13T00:00:00Z");
    const startLocalMinus = new Date(startLocal.getTime() - kolkataOffset);
    const endLocalMinus = new Date(endLocal.getTime() - kolkataOffset);
    expect(
      eventOverlapsWindow(startLocal, endLocal, true, dateWindow.start, dateWindow.end),
    ).toBe(
      eventOverlapsWindow(startLocalMinus, endLocalMinus, true, dateWindow.start, dateWindow.end),
    );
  });
});

describe("expandToOccurrences", () => {
  it("returns an occurrence when the event overlaps the window", () => {
    const event = makeEvent({ startIso: "2024-03-02T10:00:00Z", endIso: "2024-03-02T11:00:00Z" });
    const result = expandToOccurrences(event, window7.start, window7.end);
    expect(result).toHaveLength(1);
    expect(result[0]?.eventId).toBe(1);
  });

  it("returns an empty array when the event does not overlap", () => {
    const event = makeEvent({ startIso: "2024-03-15T10:00:00Z", endIso: "2024-03-15T11:00:00Z" });
    expect(expandToOccurrences(event, window7.start, window7.end)).toHaveLength(0);
  });

  it("maps all fields from the input event onto the occurrence", () => {
    const event = makeEvent({
      id: 42,
      title: "Weekly sync",
      startIso: "2024-03-04T09:00:00Z",
      endIso: "2024-03-04T10:00:00Z",
      timezone: "America/New_York",
      orgId: "org-abc",
    });
    const [occ] = expandToOccurrences(event, window7.start, window7.end);
    expect(occ).toMatchObject({
      eventId: 42,
      title: "Weekly sync",
      timezone: "America/New_York",
      orgId: "org-abc",
    });
  });

  it("captures an event that starts before the window", () => {
    const event = makeEvent({ startIso: "2024-02-28T22:00:00Z", endIso: "2024-03-01T02:00:00Z" });
    expect(expandToOccurrences(event, window7.start, window7.end)).toHaveLength(1);
  });
});

describe("expandToOccurrences — exception modifiedEnd anchor (Bug 2 regression gate)", () => {
  const WEEKLY_MON = "FREQ=WEEKLY;BYDAY=MO";
  const recurringEvent: CalendarEventLike = {
    id: 10,
    title: "Mon standup",
    startDate: new Date("2024-02-05T09:00:00Z"),
    endDate: new Date("2024-02-05T09:30:00Z"),
    allDay: false,
    timezone: "UTC",
    orgId: "org-bug2",
    rrule: WEEKLY_MON,
    recurrenceEnd: null,
  };
  const windowStart = new Date("2024-03-04T00:00:00Z");
  const windowEnd = new Date("2024-03-04T23:59:59Z");
  const nominalStart = new Date("2024-03-04T09:00:00Z");
  const modifiedStart = new Date("2024-03-04T15:00:00Z");

  it("exception with modifiedStart but NO modifiedEnd: endDate is modifiedStart + original duration (fails if nominal-anchored)", () => {
    const exception = {
      occurrenceStart: nominalStart,
      isCancelled: false,
      modifiedTitle: null,
      modifiedStart,
      modifiedEnd: null,
    };
    const result = expandToOccurrences(recurringEvent, windowStart, windowEnd, [exception]);
    expect(result).toHaveLength(1);
    const occ = result[0]!;
    expect(occ.startDate.toISOString()).toBe(modifiedStart.toISOString());
    expect(occ.endDate.getTime()).toBeGreaterThan(occ.startDate.getTime());
    const originalDurationMs = recurringEvent.endDate.getTime() - recurringEvent.startDate.getTime();
    expect(occ.endDate.getTime() - occ.startDate.getTime()).toBe(originalDurationMs);
  });

  it("exception with explicit modifiedEnd still uses that exact value (existing behaviour preserved)", () => {
    const explicitEnd = new Date("2024-03-04T16:00:00Z");
    const exception = {
      occurrenceStart: nominalStart,
      isCancelled: false,
      modifiedTitle: null,
      modifiedStart,
      modifiedEnd: explicitEnd,
    };
    const result = expandToOccurrences(recurringEvent, windowStart, windowEnd, [exception]);
    expect(result).toHaveLength(1);
    expect(result[0]!.endDate.toISOString()).toBe(explicitEnd.toISOString());
  });

  it("unmodified occurrence uses nominal end derived from nominal start (no exception: not affected by fix)", () => {
    const result = expandToOccurrences(recurringEvent, windowStart, windowEnd, []);
    expect(result).toHaveLength(1);
    const occ = result[0]!;
    const originalDurationMs = recurringEvent.endDate.getTime() - recurringEvent.startDate.getTime();
    expect(occ.endDate.getTime() - occ.startDate.getTime()).toBe(originalDurationMs);
  });
});
