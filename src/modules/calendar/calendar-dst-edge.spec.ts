import {
  expandToOccurrences,
  type CalendarEventLike,
} from "./calendar-occurrence.service";
import { createEventSchema } from "./dto/calendar.schemas";

function makeNyEvent(
  startUtcIso: string,
  endUtcIso: string,
  overrides: Partial<CalendarEventLike> = {},
): CalendarEventLike {
  return {
    id: 1,
    title: "NY weekly",
    startDate: new Date(startUtcIso),
    endDate: new Date(endUtcIso),
    allDay: false,
    timezone: "America/New_York",
    orgId: "org-dst",
    rrule: "FREQ=WEEKLY;BYDAY=MO",
    recurrenceEnd: null,
    ...overrides,
  };
}

describe("expandToOccurrences — DST fall-back (America/New_York 2024-11-03: EDT→EST)", () => {
  it("weekly 09:00 NY meeting: occurrence BEFORE fall-back is at 13:00 UTC (EDT, −04:00)", () => {
    const event = makeNyEvent(
      "2024-10-28T13:00:00Z",
      "2024-10-28T13:30:00Z",
    );
    const windowStart = new Date("2024-10-28T12:55:00Z");
    const windowEnd = new Date("2024-10-28T13:15:00Z");
    const occurrences = expandToOccurrences(event, windowStart, windowEnd);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.startDate.toISOString()).toBe("2024-10-28T13:00:00.000Z");
  });

  it("weekly 09:00 NY meeting: occurrence AFTER fall-back is at 14:00 UTC (EST, −05:00) — local stays 09:00", () => {
    const event = makeNyEvent(
      "2024-10-28T13:00:00Z",
      "2024-10-28T13:30:00Z",
    );
    const windowStart = new Date("2024-11-04T13:55:00Z");
    const windowEnd = new Date("2024-11-04T14:15:00Z");
    const occurrences = expandToOccurrences(event, windowStart, windowEnd);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.startDate.toISOString()).toBe("2024-11-04T14:00:00.000Z");
  });

  it("BITE PROOF: the occurrence after fall-back is NOT at 13:00 UTC (which would be 08:00 local — an hour early)", () => {
    const event = makeNyEvent(
      "2024-10-28T13:00:00Z",
      "2024-10-28T13:30:00Z",
    );
    const windowStart = new Date("2024-11-04T12:55:00Z");
    const windowEnd = new Date("2024-11-04T13:15:00Z");
    const occurrences = expandToOccurrences(event, windowStart, windowEnd);
    expect(occurrences).toHaveLength(0);
  });

  it("fall-back does not produce two occurrences for the same local time (no ambiguous-hour duplication)", () => {
    const event = makeNyEvent(
      "2024-10-28T13:00:00Z",
      "2024-10-28T13:30:00Z",
    );
    const windowStart = new Date("2024-11-03T00:00:00Z");
    const windowEnd = new Date("2024-11-04T23:59:00Z");
    const occurrences = expandToOccurrences(event, windowStart, windowEnd);
    const starts = occurrences.map((o) => o.startDate.toISOString());
    const uniqueStarts = new Set(starts);
    expect(uniqueStarts.size).toBe(occurrences.length);
  });
});

describe("expandToOccurrences — DST spring-forward (America/New_York 2024-03-10: EST→EDT)", () => {
  it("weekly 09:00 NY meeting: occurrence BEFORE spring-forward is at 14:00 UTC (EST, −05:00)", () => {
    const event = makeNyEvent(
      "2024-03-04T14:00:00Z",
      "2024-03-04T14:30:00Z",
    );
    const windowStart = new Date("2024-03-04T13:55:00Z");
    const windowEnd = new Date("2024-03-04T14:15:00Z");
    const occurrences = expandToOccurrences(event, windowStart, windowEnd);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.startDate.toISOString()).toBe("2024-03-04T14:00:00.000Z");
  });

  it("weekly 09:00 NY meeting: occurrence AFTER spring-forward is at 13:00 UTC (EDT, −04:00) — local stays 09:00", () => {
    const event = makeNyEvent(
      "2024-03-04T14:00:00Z",
      "2024-03-04T14:30:00Z",
    );
    const windowStart = new Date("2024-03-11T12:55:00Z");
    const windowEnd = new Date("2024-03-11T13:15:00Z");
    const occurrences = expandToOccurrences(event, windowStart, windowEnd);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.startDate.toISOString()).toBe("2024-03-11T13:00:00.000Z");
  });

  it("BITE PROOF: the occurrence after spring-forward is NOT at 14:00 UTC (which would be 10:00 local — an hour late)", () => {
    const event = makeNyEvent(
      "2024-03-04T14:00:00Z",
      "2024-03-04T14:30:00Z",
    );
    const windowStart = new Date("2024-03-11T13:55:00Z");
    const windowEnd = new Date("2024-03-11T14:15:00Z");
    const occurrences = expandToOccurrences(event, windowStart, windowEnd);
    expect(occurrences).toHaveLength(0);
  });
});

describe("expandToOccurrences — zero-duration event (startDate == endDate)", () => {
  it("a zero-duration event strictly inside the window IS returned with startDate === endDate", () => {
    const event: CalendarEventLike = {
      id: 2,
      title: "Instant marker",
      startDate: new Date("2024-06-05T10:00:00Z"),
      endDate: new Date("2024-06-05T10:00:00Z"),
      allDay: false,
      timezone: "UTC",
      orgId: "org-dst",
      rrule: null,
    };
    const windowStart = new Date("2024-06-05T09:00:00Z");
    const windowEnd = new Date("2024-06-05T11:00:00Z");
    const results = expandToOccurrences(event, windowStart, windowEnd);
    expect(results).toHaveLength(1);
    const occ = results[0]!;
    expect(occ.startDate.getTime()).toBe(occ.endDate.getTime());
  });

  it("a zero-duration event sitting exactly at the window start is NOT included (exclusive boundary)", () => {
    const event: CalendarEventLike = {
      id: 3,
      title: "Boundary marker",
      startDate: new Date("2024-06-05T09:00:00Z"),
      endDate: new Date("2024-06-05T09:00:00Z"),
      allDay: false,
      timezone: "UTC",
      orgId: "org-dst",
      rrule: null,
    };
    const windowStart = new Date("2024-06-05T09:00:00Z");
    const windowEnd = new Date("2024-06-05T11:00:00Z");
    const results = expandToOccurrences(event, windowStart, windowEnd);
    expect(results).toHaveLength(0);
  });

  it("a recurring series with zero duration expands without crashing and preserves zero duration in occurrences", () => {
    const event: CalendarEventLike = {
      id: 4,
      title: "Zero-dur series",
      startDate: new Date("2024-06-03T10:00:00Z"),
      endDate: new Date("2024-06-03T10:00:00Z"),
      allDay: false,
      timezone: "UTC",
      orgId: "org-dst",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      recurrenceEnd: null,
    };
    const windowStart = new Date("2024-06-03T09:00:00Z");
    const windowEnd = new Date("2024-06-03T11:00:00Z");
    let threw = false;
    let results: ReturnType<typeof expandToOccurrences> = [];
    try {
      results = expandToOccurrences(event, windowStart, windowEnd);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    for (const occ of results)
      expect(occ.endDate.getTime()).toBeGreaterThanOrEqual(occ.startDate.getTime());
  });
});

describe("createEventSchema — rejects zero-duration and negative-duration events", () => {
  const BASE = {
    title: "Test event",
    timezone: "UTC",
    category: "general",
  };

  it("rejects an event where endDate equals startDate (zero duration)", () => {
    const result = createEventSchema.safeParse({
      ...BASE,
      startDate: "2024-06-05T10:00:00Z",
      endDate: "2024-06-05T10:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an event where endDate is before startDate (negative duration)", () => {
    const result = createEventSchema.safeParse({
      ...BASE,
      startDate: "2024-06-05T11:00:00Z",
      endDate: "2024-06-05T10:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("BITE PROOF: accepts an event where endDate is after startDate (valid duration)", () => {
    const result = createEventSchema.safeParse({
      ...BASE,
      startDate: "2024-06-05T10:00:00Z",
      endDate: "2024-06-05T10:30:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("BITE PROOF: rejects negative duration even with 1ms difference (boundary)", () => {
    const result = createEventSchema.safeParse({
      ...BASE,
      startDate: "2024-06-05T10:00:00.001Z",
      endDate: "2024-06-05T10:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});

describe("expandToOccurrences — recurring event crossing both DST transitions (full year)", () => {
  it("a weekly 09:00 UTC series stays at 09:00 UTC regardless of zone shifts (UTC has no DST)", () => {
    const event: CalendarEventLike = {
      id: 5,
      title: "UTC weekly",
      startDate: new Date("2024-01-01T09:00:00Z"),
      endDate: new Date("2024-01-01T09:30:00Z"),
      allDay: false,
      timezone: "UTC",
      orgId: "org-dst",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      recurrenceEnd: null,
    };
    const windowStart = new Date("2024-03-11T08:55:00Z");
    const windowEnd = new Date("2024-03-11T09:15:00Z");
    const occurrences = expandToOccurrences(event, windowStart, windowEnd);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.startDate.toISOString()).toBe("2024-03-11T09:00:00.000Z");
  });

  it("Asia/Kolkata (+05:30): non-DST zone weekly 09:00 IST is always at 03:30 UTC regardless of NH hemisphere season", () => {
    const event: CalendarEventLike = {
      id: 6,
      title: "IST weekly",
      startDate: new Date("2024-01-01T03:30:00Z"),
      endDate: new Date("2024-01-01T04:00:00Z"),
      allDay: false,
      timezone: "Asia/Kolkata",
      orgId: "org-dst",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      recurrenceEnd: null,
    };
    const windowStart = new Date("2024-06-03T03:25:00Z");
    const windowEnd = new Date("2024-06-03T03:45:00Z");
    const occurrences = expandToOccurrences(event, windowStart, windowEnd);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.startDate.toISOString()).toBe("2024-06-03T03:30:00.000Z");
  });
});
