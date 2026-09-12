import {
  isKnownTimeZone,
  isWithinWorkingHours,
  localParts,
  nextOpening,
  OUTBOUND_WORKING_HOURS,
} from "./working-hours";

describe("localParts", () => {
  it("reads the local weekday and hour in the given zone", () => {
    // 2026-08-26 is a Wednesday. 10:00 UTC is 15:30 in Kolkata.
    expect(localParts(new Date("2026-08-26T10:00:00Z"), "Asia/Kolkata")).toEqual({
      weekday: 3,
      hour: 15,
      minute: 30,
    });
  });

  it("crosses the date line into the previous day", () => {
    // 03:00 UTC Wednesday is 20:00 Tuesday in Los Angeles.
    expect(localParts(new Date("2026-08-26T03:00:00Z"), "America/Los_Angeles")).toEqual({
      weekday: 2,
      hour: 20,
      minute: 0,
    });
  });

  it("falls back to UTC rather than throwing on a zone from an import", () => {
    expect(localParts(new Date("2026-08-26T10:00:00Z"), "Mars/Olympus_Mons")).toEqual({
      weekday: 3,
      hour: 10,
      minute: 0,
    });
  });

  it("knows which zones the runtime recognises", () => {
    expect(isKnownTimeZone("America/New_York")).toBe(true);
    expect(isKnownTimeZone("Mars/Olympus_Mons")).toBe(false);
  });
});

describe("isWithinWorkingHours", () => {
  it("is open at the opening hour and closed at the closing one", () => {
    // Wednesday.
    expect(isWithinWorkingHours(new Date("2026-08-26T09:00:00Z"), "UTC")).toBe(true);
    expect(isWithinWorkingHours(new Date("2026-08-26T16:59:00Z"), "UTC")).toBe(true);
    expect(isWithinWorkingHours(new Date("2026-08-26T17:00:00Z"), "UTC")).toBe(false);
    expect(isWithinWorkingHours(new Date("2026-08-26T08:59:00Z"), "UTC")).toBe(false);
  });

  it("is closed at the weekend", () => {
    // 2026-08-29 is a Saturday, 2026-08-30 a Sunday.
    expect(isWithinWorkingHours(new Date("2026-08-29T12:00:00Z"), "UTC")).toBe(false);
    expect(isWithinWorkingHours(new Date("2026-08-30T12:00:00Z"), "UTC")).toBe(false);
  });

  /**
   * The criterion that makes the timezone load-bearing rather than decorative:
   * the same instant is inside the window for one party and the middle of the
   * night for another.
   */
  it("answers differently for two parties at the same instant", () => {
    const instant = new Date("2026-08-26T10:00:00Z");
    expect(isWithinWorkingHours(instant, "Europe/London")).toBe(true);
    expect(isWithinWorkingHours(instant, "America/Los_Angeles")).toBe(false);
  });
});

describe("nextOpening", () => {
  it("returns the instant unchanged when the window is already open", () => {
    const instant = new Date("2026-08-26T10:00:00Z");
    expect(nextOpening(instant, "UTC")).toEqual(instant);
  });

  it("opens at the start of the same day when it is too early", () => {
    expect(nextOpening(new Date("2026-08-26T06:12:00Z"), "UTC")).toEqual(
      new Date("2026-08-26T09:00:00Z"),
    );
  });

  it("rolls to the next morning when the window has closed", () => {
    expect(nextOpening(new Date("2026-08-26T18:40:00Z"), "UTC")).toEqual(
      new Date("2026-08-27T09:00:00Z"),
    );
  });

  it("skips the weekend from a Friday evening", () => {
    // 2026-08-28 is a Friday.
    expect(nextOpening(new Date("2026-08-28T19:00:00Z"), "UTC")).toEqual(
      new Date("2026-08-31T09:00:00Z"),
    );
  });

  it("resolves in the party's zone, not the server's", () => {
    // 2026-08-26 16:00 UTC is 09:00 in Los Angeles — already open there.
    const instant = new Date("2026-08-26T16:00:00Z");
    expect(nextOpening(instant, "America/Los_Angeles")).toEqual(instant);
    // …and closed in London, where it is 17:00.
    expect(nextOpening(instant, "Europe/London")).toEqual(new Date("2026-08-27T08:00:00Z"));
  });

  it("lands on a half-hour offset zone exactly on the opening minute", () => {
    // 2026-08-26 02:00 UTC is 07:30 in Kolkata; the window opens at 09:00 IST,
    // which is 03:30 UTC.
    expect(nextOpening(new Date("2026-08-26T02:00:00Z"), "Asia/Kolkata")).toEqual(
      new Date("2026-08-26T03:30:00Z"),
    );
  });

  it("always returns an instant that is itself inside the window", () => {
    const zones = ["UTC", "Asia/Kolkata", "America/Los_Angeles", "Australia/Sydney", "Europe/Berlin"];
    for (const zone of zones) {
      // Every third hour across a whole week: enough to cross both edges of the
      // window and both ends of the weekend in every zone, without paying for
      // 840 timezone walks on a machine several suites are sharing.
      for (let hour = 0; hour < 24 * 7; hour += 3) {
        const instant = new Date(Date.UTC(2026, 7, 24, hour));
        const opening = nextOpening(instant, zone);
        expect(isWithinWorkingHours(opening, zone)).toBe(true);
        expect(opening.getTime()).toBeGreaterThanOrEqual(instant.getTime());
      }
    }
  });

  it("crosses a DST transition without landing outside the window", () => {
    // US clocks go forward on 2026-03-08.
    const instant = new Date("2026-03-07T23:00:00Z");
    const opening = nextOpening(instant, "America/New_York");
    expect(isWithinWorkingHours(opening, "America/New_York")).toBe(true);
  });

  it("uses the module's own constant as the default window", () => {
    expect(OUTBOUND_WORKING_HOURS).toEqual({ startHour: 9, endHour: 17, days: [1, 2, 3, 4, 5] });
  });
});
