import { externalEventsQuerySchema, CALENDAR_MAX_SPAN_DAYS } from "./calendar.schemas";

function addDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 86_400_000);
}

describe("externalEventsQuerySchema — date-range constraints", () => {
  const base = new Date("2024-01-01T00:00:00.000Z");

  it("accepts a normal 3-month calendar range (~90 days)", () => {
    const result = externalEventsQuerySchema.safeParse({
      start: base.toISOString(),
      end: addDays(base, 90).toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it("accepts exactly the maximum span of 120 days", () => {
    const result = externalEventsQuerySchema.safeParse({
      start: base.toISOString(),
      end: addDays(base, CALENDAR_MAX_SPAN_DAYS).toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it("rejects a 121-day span", () => {
    const result = externalEventsQuerySchema.safeParse({
      start: base.toISOString(),
      end: addDays(base, 121).toISOString(),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("end");
    }
  });

  it("rejects end equal to start", () => {
    const result = externalEventsQuerySchema.safeParse({
      start: base.toISOString(),
      end: base.toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it("rejects end before start", () => {
    const result = externalEventsQuerySchema.safeParse({
      start: base.toISOString(),
      end: addDays(base, -1).toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unbounded multi-year range", () => {
    const result = externalEventsQuerySchema.safeParse({
      start: new Date("2000-01-01").toISOString(),
      end: new Date("2099-01-01").toISOString(),
    });
    expect(result.success).toBe(false);
  });
});
