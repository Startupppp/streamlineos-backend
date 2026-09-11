import {
  CALENDAR_MAX_SPAN_DAYS,
  listEventsSchema,
} from "./calendar.schemas";

/**
 * Mirrors the web calendar's fetch window: startOfMonth(currentDate - 1 month)
 * through endOfMonth(currentDate + 1 month). Written out rather than imported
 * because the client is a separate package — if that window ever widens, this
 * must widen with it, and the assertion below is what forces the conversation.
 */
function clientWindow(year: number, month: number): { start: Date; end: Date } {
  const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const end = new Date(year, month + 2, 0, 23, 59, 59, 999);
  return { start, end };
}

function spanDays(start: Date, end: Date): number {
  return (end.getTime() - start.getTime()) / 86_400_000;
}

describe("calendar span limit vs the client's real request", () => {
  it("accepts the widest three-month window the client can ask for, across five years", () => {
    for (let year = 2024; year <= 2028; year += 1) {
      for (let month = 0; month < 12; month += 1) {
        const { start, end } = clientWindow(year, month);
        const result = listEventsSchema.safeParse({
          start: start.toISOString(),
          end: end.toISOString(),
        });
        expect({
          month: `${year}-${String(month + 1).padStart(2, "0")}`,
          ok: result.success,
        }).toEqual({
          month: `${year}-${String(month + 1).padStart(2, "0")}`,
          ok: true,
        });
      }
    }
  });

  it("keeps real headroom over that worst case, so one day of padding cannot break the calendar", () => {
    let widest = 0;
    for (let year = 2024; year <= 2028; year += 1) {
      for (let month = 0; month < 12; month += 1) {
        const { start, end } = clientWindow(year, month);
        widest = Math.max(widest, spanDays(start, end));
      }
    }
    // The worst case is 92 days (Feb 29 2024 -> May 31 2024), plus up to one
    // hour: `clientWindow` builds host-local Dates, exactly as the browser
    // does, so a window straddling a DST fall-back really is 92d 1h on the
    // wire. Asserting a flat 92 made this fail under any DST-observing host
    // (Europe/Berlin, America/New_York) while passing at UTC.
    const DST_SLACK_DAYS = 1 / 24;
    expect(widest).toBeLessThanOrEqual(92 + DST_SLACK_DAYS);
    // A limit equal to the worst case would pass this suite while being one
    // padding day from breaking.
    expect(CALENDAR_MAX_SPAN_DAYS).toBeGreaterThanOrEqual(widest + 14);
  });

  it("still refuses an unbounded range, which is what the limit is for", () => {
    const result = listEventsSchema.safeParse({
      start: new Date(2024, 0, 1).toISOString(),
      end: new Date(2026, 0, 1).toISOString(),
    });
    expect(result.success).toBe(false);
  });
});
