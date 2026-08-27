import { calendarEvents } from "../../db/schema/common/calendar-events";
import {
  createEventSchema,
  updateEventSchema,
} from "./dto/calendar.schemas";

const VALID_CREATE_BASE = {
  title: "Team Standup",
  startDate: "2024-03-10T14:00:00Z",
  endDate: "2024-03-10T15:00:00Z",
  timezone: "UTC",
};

describe("calendar_events — recurrence columns are removed from the schema", () => {
  it("calendarEvents table has no isRecurring column", () => {
    expect("isRecurring" in calendarEvents).toBe(false);
  });

  it("calendarEvents table has no recurringRule column", () => {
    expect("recurringRule" in calendarEvents).toBe(false);
  });

  it("createEventSchema output does not carry isRecurring even when supplied", () => {
    const result = createEventSchema.safeParse({
      ...VALID_CREATE_BASE,
      isRecurring: true,
    });
    expect(result.success).toBe(true);
    if (result.success) expect("isRecurring" in result.data).toBe(false);
  });

  it("createEventSchema output does not carry recurringRule even when supplied", () => {
    const result = createEventSchema.safeParse({
      ...VALID_CREATE_BASE,
      recurringRule: "FREQ=WEEKLY",
    });
    expect(result.success).toBe(true);
    if (result.success) expect("recurringRule" in result.data).toBe(false);
  });

  it("updateEventSchema output does not carry isRecurring even when supplied", () => {
    const result = updateEventSchema.safeParse({ isRecurring: false });
    expect(result.success).toBe(true);
    if (result.success) expect("isRecurring" in result.data).toBe(false);
  });

  it("updateEventSchema output does not carry recurringRule even when supplied", () => {
    const result = updateEventSchema.safeParse({ recurringRule: "FREQ=DAILY" });
    expect(result.success).toBe(true);
    if (result.success) expect("recurringRule" in result.data).toBe(false);
  });
});

describe("calendar_events — timezone field validation", () => {
  it("createEventSchema requires timezone", () => {
    const { timezone: _tz, ...withoutTimezone } = VALID_CREATE_BASE;
    const result = createEventSchema.safeParse(withoutTimezone);
    expect(result.success).toBe(false);
  });

  it("createEventSchema accepts a valid IANA zone", () => {
    const result = createEventSchema.safeParse({
      ...VALID_CREATE_BASE,
      timezone: "America/New_York",
    });
    expect(result.success).toBe(true);
  });

  it("createEventSchema accepts UTC", () => {
    const result = createEventSchema.safeParse(VALID_CREATE_BASE);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.timezone).toBe("UTC");
  });

  it("createEventSchema rejects an offset string in place of an IANA name", () => {
    const result = createEventSchema.safeParse({
      ...VALID_CREATE_BASE,
      timezone: "+05:30",
    });
    expect(result.success).toBe(false);
  });

  it("createEventSchema rejects a made-up zone name", () => {
    const result = createEventSchema.safeParse({
      ...VALID_CREATE_BASE,
      timezone: "Mars/Olympus",
    });
    expect(result.success).toBe(false);
  });

  it("updateEventSchema accepts a valid IANA zone", () => {
    const result = updateEventSchema.safeParse({ timezone: "Asia/Kolkata" });
    expect(result.success).toBe(true);
  });

  it("updateEventSchema rejects an invalid timezone on update", () => {
    const result = updateEventSchema.safeParse({ timezone: "Not/A/Zone" });
    expect(result.success).toBe(false);
  });

  it("updateEventSchema treats missing timezone as absent (field is optional)", () => {
    const result = updateEventSchema.safeParse({ title: "New title" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.timezone).toBeUndefined();
  });
});

describe("calendar_events — UTC instants and IANA zone display (DST both directions + non-hour offset)", () => {
  function localTimeInZone(utcIso: string, iana: string): string {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: iana,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(utcIso));
  }

  describe("America/New_York spring-forward (2024-03-10): EST→EDT", () => {
    it("UTC 06:59 reads as 01:59 in EST (−05:00, before the gap)", () => {
      expect(localTimeInZone("2024-03-10T06:59:00Z", "America/New_York")).toContain("01:59");
    });

    it("UTC 07:00 reads as 03:00 in EDT (−04:00, after clocks moved forward)", () => {
      expect(localTimeInZone("2024-03-10T07:00:00Z", "America/New_York")).toContain("03:00");
    });

    it("a 09:00 meeting stored as UTC is the same instant regardless of whether the observer is in EST or EDT", () => {
      const nineAmEst = "2024-03-10T14:00:00Z";
      expect(localTimeInZone(nineAmEst, "America/New_York")).toContain("10:00");
      expect(localTimeInZone(nineAmEst, "Europe/London")).toContain("14:00");
    });
  });

  describe("America/New_York fall-back (2024-11-03): EDT→EST", () => {
    it("UTC 05:59 reads as 01:59 in EDT (−04:00, before clocks roll back)", () => {
      expect(localTimeInZone("2024-11-03T05:59:00Z", "America/New_York")).toContain("01:59");
    });

    it("UTC 06:01 reads as 01:01 in EST (−05:00, after clocks rolled back)", () => {
      expect(localTimeInZone("2024-11-03T06:01:00Z", "America/New_York")).toContain("01:01");
    });
  });

  describe("Asia/Kolkata (+05:30 — non-hour offset, no DST)", () => {
    it("UTC 03:30 reads as 09:00 in IST", () => {
      expect(localTimeInZone("2024-01-15T03:30:00Z", "Asia/Kolkata")).toContain("09:00");
    });

    it("UTC 18:30 reads as 00:00 next day in IST", () => {
      const local = localTimeInZone("2024-01-15T18:30:00Z", "Asia/Kolkata");
      expect(local).toContain("2024-01-16");
      expect(local).toContain("00:00");
    });

    it("a 30-minute offset correctly separates UTC 03:30 from UTC 03:00 (different local hours)", () => {
      const at0330 = localTimeInZone("2024-06-01T03:30:00Z", "Asia/Kolkata");
      const at0300 = localTimeInZone("2024-06-01T03:00:00Z", "Asia/Kolkata");
      expect(at0330).toContain("09:00");
      expect(at0300).toContain("08:30");
    });
  });
});
