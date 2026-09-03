import {
  expandToOccurrences,
  type CalendarEventLike,
} from "./calendar-occurrence.service";

const ORG = "org-recurrence-end";

function weekly(overrides: Partial<CalendarEventLike> = {}): CalendarEventLike {
  return {
    id: 1,
    title: "Weekly standup",
    startDate: new Date("2024-06-03T10:00:00Z"),
    endDate: new Date("2024-06-03T10:30:00Z"),
    allDay: false,
    timezone: "UTC",
    orgId: ORG,
    rrule: "FREQ=WEEKLY;BYDAY=MO",
    recurrenceEnd: null,
    ...overrides,
  };
}

describe("expandToOccurrences — recurrenceEnd truncates the series", () => {
  const windowStart = new Date("2024-06-01T00:00:00Z");
  const windowEnd = new Date("2024-07-31T00:00:00Z");

  it("no occurrence starts after recurrenceEnd", () => {
    const event = weekly({ recurrenceEnd: new Date("2024-06-17T10:00:00Z") });
    const occurrences = expandToOccurrences(event, windowStart, windowEnd);
    const starts = occurrences.map((o) => o.startDate.toISOString());
    expect(starts).toEqual([
      "2024-06-03T10:00:00.000Z",
      "2024-06-10T10:00:00.000Z",
      "2024-06-17T10:00:00.000Z",
    ]);
  });

  it("an occurrence starting exactly at recurrenceEnd is kept (UNTIL is inclusive)", () => {
    const event = weekly({ recurrenceEnd: new Date("2024-06-10T10:00:00Z") });
    const starts = expandToOccurrences(event, windowStart, windowEnd).map((o) =>
      o.startDate.toISOString(),
    );
    expect(starts).toContain("2024-06-10T10:00:00.000Z");
    expect(starts).not.toContain("2024-06-17T10:00:00.000Z");
  });

  it("BITE PROOF: with recurrenceEnd null the later occurrences ARE produced — the bound is the gate", () => {
    const event = weekly({ recurrenceEnd: null });
    const starts = expandToOccurrences(event, windowStart, windowEnd).map((o) =>
      o.startDate.toISOString(),
    );
    expect(starts).toContain("2024-06-24T10:00:00.000Z");
    expect(starts).toContain("2024-07-29T10:00:00.000Z");
  });

  it("a window entirely past recurrenceEnd yields nothing", () => {
    const event = weekly({ recurrenceEnd: new Date("2024-06-17T10:00:00Z") });
    const occurrences = expandToOccurrences(
      event,
      new Date("2024-07-01T00:00:00Z"),
      new Date("2024-07-31T00:00:00Z"),
    );
    expect(occurrences).toHaveLength(0);
  });

  it("recurrenceEnd bounds the NOMINAL occurrence, so an exception may move a live occurrence past it", () => {
    const event = weekly({ recurrenceEnd: new Date("2024-06-10T10:00:00Z") });
    const occurrences = expandToOccurrences(event, windowStart, windowEnd, [
      {
        occurrenceStart: new Date("2024-06-10T10:00:00Z"),
        isCancelled: false,
        modifiedStart: new Date("2024-06-27T15:00:00Z"),
      },
    ]);
    const starts = occurrences.map((o) => o.startDate.toISOString());
    expect(starts).toContain("2024-06-27T15:00:00.000Z");
  });

  it("recurrenceEnd is honoured in a DST zone across the transition (America/New_York)", () => {
    const event = weekly({
      timezone: "America/New_York",
      startDate: new Date("2024-10-28T13:00:00Z"),
      endDate: new Date("2024-10-28T13:30:00Z"),
      recurrenceEnd: new Date("2024-11-11T14:00:00Z"),
    });
    const starts = expandToOccurrences(
      event,
      new Date("2024-10-01T00:00:00Z"),
      new Date("2024-12-15T00:00:00Z"),
    ).map((o) => o.startDate.toISOString());
    expect(starts).toEqual([
      "2024-10-28T13:00:00.000Z",
      "2024-11-04T14:00:00.000Z",
      "2024-11-11T14:00:00.000Z",
    ]);
  });
});

describe("expandToOccurrences — RRULE UNTIL is interpreted in the event's zone, not as a wall-clock literal", () => {
  const windowStart = new Date("2024-06-01T00:00:00Z");
  const windowEnd = new Date("2024-07-31T00:00:00Z");

  it("UNTIL one hour BEFORE the occurrence instant excludes that occurrence (America/New_York)", () => {
    const event: CalendarEventLike = {
      id: 2,
      title: "NY weekly",
      startDate: new Date("2024-06-03T13:00:00Z"),
      endDate: new Date("2024-06-03T13:30:00Z"),
      allDay: false,
      timezone: "America/New_York",
      orgId: ORG,
      rrule: "FREQ=WEEKLY;BYDAY=MO;UNTIL=20240617T120000Z",
      recurrenceEnd: null,
    };
    const starts = expandToOccurrences(event, windowStart, windowEnd).map((o) =>
      o.startDate.toISOString(),
    );
    expect(starts).toEqual([
      "2024-06-03T13:00:00.000Z",
      "2024-06-10T13:00:00.000Z",
    ]);
  });

  it("BITE PROOF: UNTIL one hour AFTER the same occurrence instant includes it", () => {
    const event: CalendarEventLike = {
      id: 3,
      title: "NY weekly",
      startDate: new Date("2024-06-03T13:00:00Z"),
      endDate: new Date("2024-06-03T13:30:00Z"),
      allDay: false,
      timezone: "America/New_York",
      orgId: ORG,
      rrule: "FREQ=WEEKLY;BYDAY=MO;UNTIL=20240617T140000Z",
      recurrenceEnd: null,
    };
    const starts = expandToOccurrences(event, windowStart, windowEnd).map((o) =>
      o.startDate.toISOString(),
    );
    expect(starts).toContain("2024-06-17T13:00:00.000Z");
  });

  it("a UTC-zone series is unaffected by the UNTIL conversion", () => {
    const event = weekly({
      rrule: "FREQ=WEEKLY;BYDAY=MO;UNTIL=20240617T100000Z",
    });
    const starts = expandToOccurrences(event, windowStart, windowEnd).map((o) =>
      o.startDate.toISOString(),
    );
    expect(starts).toEqual([
      "2024-06-03T10:00:00.000Z",
      "2024-06-10T10:00:00.000Z",
      "2024-06-17T10:00:00.000Z",
    ]);
  });

  it("recurrenceEnd and UNTIL together take the earlier bound", () => {
    const event = weekly({
      rrule: "FREQ=WEEKLY;BYDAY=MO;UNTIL=20240701T100000Z",
      recurrenceEnd: new Date("2024-06-10T10:00:00Z"),
    });
    const starts = expandToOccurrences(event, windowStart, windowEnd).map((o) =>
      o.startDate.toISOString(),
    );
    expect(starts).toEqual([
      "2024-06-03T10:00:00.000Z",
      "2024-06-10T10:00:00.000Z",
    ]);
  });
});
