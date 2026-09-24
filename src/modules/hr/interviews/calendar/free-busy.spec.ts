import {
  freeWithin,
  mergeIntervals,
  overlapsAny,
  panelFreeWithin,
  slotsFrom,
  type Interval,
} from "./free-busy";
import { resolveCalendar, CALENDAR_ADAPTERS } from "./calendar-provider";

/** 2026-03-02 was a Monday. Times are UTC throughout; display is the caller's problem. */
const at = (hhmm: string): Date => new Date(`2026-03-02T${hhmm}:00.000Z`);
const span = (from: string, to: string): Interval => ({ start: at(from), end: at(to) });
const asText = (intervals: Interval[]) =>
  intervals.map((i) => `${i.start.toISOString().slice(11, 16)}-${i.end.toISOString().slice(11, 16)}`);

describe("mergeIntervals", () => {
  it("joins overlapping blocks", () => {
    expect(asText(mergeIntervals([span("09:00", "10:30"), span("10:00", "11:00")]))).toEqual([
      "09:00-11:00",
    ]);
  });

  /**
   * Touching blocks must merge, or the zero-length gap between them is offered
   * as free time.
   */
  it("joins blocks that merely touch", () => {
    expect(asText(mergeIntervals([span("09:00", "10:00"), span("10:00", "11:00")]))).toEqual([
      "09:00-11:00",
    ]);
  });

  it("keeps a real gap between blocks", () => {
    expect(asText(mergeIntervals([span("09:00", "10:00"), span("11:00", "12:00")]))).toEqual([
      "09:00-10:00",
      "11:00-12:00",
    ]);
  });

  it("does not care what order they arrive in", () => {
    expect(asText(mergeIntervals([span("11:00", "12:00"), span("09:00", "10:00")]))).toEqual([
      "09:00-10:00",
      "11:00-12:00",
    ]);
  });

  it("swallows a block entirely inside another", () => {
    expect(asText(mergeIntervals([span("09:00", "17:00"), span("11:00", "12:00")]))).toEqual([
      "09:00-17:00",
    ]);
  });

  it("drops a zero-length or inverted block", () => {
    expect(mergeIntervals([span("09:00", "09:00"), span("12:00", "11:00")])).toEqual([]);
  });
});

describe("freeWithin", () => {
  const day = span("09:00", "17:00");

  it("returns the whole window when nobody is busy", () => {
    expect(asText(freeWithin(day, []))).toEqual(["09:00-17:00"]);
  });

  it("carves out a meeting", () => {
    expect(asText(freeWithin(day, [span("12:00", "13:00")]))).toEqual([
      "09:00-12:00",
      "13:00-17:00",
    ]);
  });

  it("returns nothing when the window is fully booked", () => {
    expect(freeWithin(day, [span("08:00", "18:00")])).toEqual([]);
  });

  it("ignores busy time entirely outside the window", () => {
    expect(asText(freeWithin(day, [span("06:00", "07:00"), span("19:00", "20:00")]))).toEqual([
      "09:00-17:00",
    ]);
  });

  it("clips a meeting that starts before the window", () => {
    expect(asText(freeWithin(day, [span("08:00", "10:00")]))).toEqual(["10:00-17:00"]);
  });

  it("clips a meeting that runs past the window", () => {
    expect(asText(freeWithin(day, [span("16:00", "19:00")]))).toEqual(["09:00-16:00"]);
  });

  it("returns nothing for an inverted window", () => {
    expect(freeWithin(span("17:00", "09:00"), [])).toEqual([]);
  });
});

describe("panelFreeWithin", () => {
  const day = span("09:00", "17:00");

  /**
   * The case the whole feature exists for: two people, neither free all day,
   * and exactly one hour they share.
   */
  it("returns only time every member is free", () => {
    const free = panelFreeWithin(day, [
      { membershipId: 1, busy: [span("09:00", "12:00"), span("13:00", "17:00")], known: true },
      { membershipId: 2, busy: [span("09:00", "11:00"), span("14:00", "17:00")], known: true },
    ]);
    expect(asText(free)).toEqual(["12:00-13:00"]);
  });

  it("returns nothing when the panel never overlaps", () => {
    const free = panelFreeWithin(day, [
      { membershipId: 1, busy: [span("09:00", "13:00")], known: true },
      { membershipId: 2, busy: [span("13:00", "17:00")], known: true },
    ]);
    expect(free).toEqual([]);
  });

  /**
   * A member with no readable calendar contributes no busy time, so the window
   * stays open. That is deliberate — a recruiter still has to be able to
   * schedule — and it is why `suggest` reports who could not be seen rather
   * than presenting the result as certain.
   */
  it("treats a member with no visible calendar as unconstrained", () => {
    const free = panelFreeWithin(day, [
      { membershipId: 1, busy: [span("12:00", "13:00")], known: true },
      { membershipId: 2, busy: [], known: false },
    ]);
    expect(asText(free)).toEqual(["09:00-12:00", "13:00-17:00"]);
  });

  it("returns the whole window for an empty panel", () => {
    expect(asText(panelFreeWithin(day, []))).toEqual(["09:00-17:00"]);
  });
});

describe("slotsFrom", () => {
  it("cuts a free window into slots on the half hour", () => {
    const slots = slotsFrom([span("09:00", "11:00")], { durationMinutes: 60 });
    expect(asText(slots)).toEqual(["09:00-10:00", "09:30-10:30", "10:00-11:00"]);
  });

  /**
   * A free window starting at 09:07 — because a meeting ran over — must not
   * produce 09:07, 09:37, 10:07. Nobody picks those.
   */
  it("aligns starts to the granularity, not to the window", () => {
    const slots = slotsFrom([span("09:07", "11:00")], { durationMinutes: 60 });
    expect(asText(slots)[0]).toBe("09:30-10:30");
  });

  it("offers nothing when the window is shorter than the interview", () => {
    expect(slotsFrom([span("09:00", "09:45")], { durationMinutes: 60 })).toEqual([]);
  });

  it("offers a slot that exactly fills the window", () => {
    expect(asText(slotsFrom([span("09:00", "10:00")], { durationMinutes: 60 }))).toEqual([
      "09:00-10:00",
    ]);
  });

  it("skips slots that start before notBefore", () => {
    const slots = slotsFrom([span("09:00", "12:00")], {
      durationMinutes: 60,
      notBefore: at("10:15"),
    });
    expect(asText(slots)).toEqual(["10:30-11:30", "11:00-12:00"]);
  });

  it("stops at the limit, across several windows", () => {
    const slots = slotsFrom([span("09:00", "12:00"), span("13:00", "17:00")], {
      durationMinutes: 60,
      limit: 3,
    });
    expect(slots).toHaveLength(3);
  });

  it("returns nothing for a zero-length interview", () => {
    expect(slotsFrom([span("09:00", "17:00")], { durationMinutes: 0 })).toEqual([]);
  });

  it("honours a custom granularity", () => {
    const slots = slotsFrom([span("09:00", "10:00")], {
      durationMinutes: 30,
      granularityMinutes: 15,
    });
    expect(asText(slots)).toEqual(["09:00-09:30", "09:15-09:45", "09:30-10:00"]);
  });
});

describe("overlapsAny", () => {
  it("finds an overlap", () => {
    expect(overlapsAny(span("09:30", "10:30"), [span("10:00", "11:00")])).toBe(true);
  });

  /** Back-to-back is not a clash: 09:00-10:00 and 10:00-11:00 both fit. */
  it("does not treat touching as overlapping", () => {
    expect(overlapsAny(span("09:00", "10:00"), [span("10:00", "11:00")])).toBe(false);
    expect(overlapsAny(span("10:00", "11:00"), [span("09:00", "10:00")])).toBe(false);
  });

  it("finds a busy block entirely inside the candidate", () => {
    expect(overlapsAny(span("09:00", "17:00"), [span("12:00", "12:30")])).toBe(true);
  });

  it("is false against nothing", () => {
    expect(overlapsAny(span("09:00", "10:00"), [])).toBe(false);
  });
});

describe("resolveCalendar", () => {
  /**
   * The registry is empty on purpose. An adapter that answered "no busy time"
   * would make every interviewer look free all week and the scheduler would
   * book straight over their real meetings, confidently.
   */
  it("ships no adapter, so nothing can claim to have read a calendar", () => {
    expect(CALENDAR_ADAPTERS.size).toBe(0);
  });

  it("blocks with no-integration when nothing is connected", () => {
    const resolved = resolveCalendar("GOOGLE_CALENDAR", null);
    expect(resolved).toMatchObject({ status: "BLOCKED", code: "no-integration" });
  });

  it("blocks as not-implemented even with live credentials saved", () => {
    const resolved = resolveCalendar("MICROSOFT_GRAPH", {
      platform: "MICROSOFT_GRAPH",
      isActive: true,
      token: "a-real-looking-token",
      meta: {},
    });
    expect(resolved).toMatchObject({ status: "BLOCKED", code: "not-implemented" });
    if ("adapter" in resolved) throw new Error("expected no adapter");
    expect(resolved.message).toContain("Offer slots by hand");
  });

  it("blocks as inactive when the row is switched off", () => {
    const resolved = resolveCalendar("GOOGLE_CALENDAR", {
      platform: "GOOGLE_CALENDAR",
      isActive: false,
      token: "t",
      meta: {},
    });
    expect(resolved).toMatchObject({ status: "BLOCKED", code: "inactive" });
  });
});
