import { createActivitySchema, timelineQuerySchema } from "./activity.schemas";

/**
 * The deal anchor's boundary, which moved here from `numericDealIds`.
 *
 * `activities.deal_id` used to be text against a `serial` key, so a caller who
 * could log an activity could anchor one to `'abc'` — and the task list, which
 * had to coerce in SQL to join it, would then 500 on every subsequent read for
 * that person. `task-list.ts` filtered those out after the fact.
 *
 * Migration 0472 made the column an integer with a foreign key, so the database
 * refuses a value that is not a deal id. What the database cannot do is refuse a
 * request before it arrives, and these cases are that: the same inputs the old
 * helper dropped silently are now rejected at the boundary, with a 400 that says
 * which field was wrong.
 */
describe("activity anchor: dealId", () => {
  const base = { kind: "task" as const, occurredAt: "2026-08-30T09:00:00.000Z" };

  it("accepts a deal id", () => {
    const parsed = createActivitySchema.safeParse({ ...base, dealId: 42 });
    expect(parsed.success && parsed.data.dealId).toBe(42);
  });

  /**
   * Coerced, not merely permitted. This field was a free string until 0472, and
   * a client still sending `"42"` must keep working rather than start 400-ing on
   * an upgrade it did not ask for.
   */
  it("still accepts the string a pre-0472 client sends", () => {
    const parsed = createActivitySchema.safeParse({ ...base, dealId: "42" });
    expect(parsed.success && parsed.data.dealId).toBe(42);
  });

  it.each([["abc"], ["12x"], ["1.5"], ["-3"], ["0"], [""], ["  "]])(
    "refuses %p rather than letting the database try to parse it",
    (dealId) => {
      expect(createActivitySchema.safeParse({ ...base, dealId }).success).toBe(false);
    },
  );

  /** Above the `serial` ceiling is not a deal id, whatever it parses to. */
  it("refuses a number too large to be a serial", () => {
    expect(createActivitySchema.safeParse({ ...base, dealId: 2_147_483_647 }).success).toBe(true);
    expect(createActivitySchema.safeParse({ ...base, dealId: 2_147_483_648 }).success).toBe(false);
  });

  /** The same field on the read side, which is where a URL reaches it. */
  it("applies the same bound to a timeline query", () => {
    expect(timelineQuerySchema.safeParse({ dealId: "7" }).success).toBe(true);
    expect(timelineQuerySchema.safeParse({ dealId: "abc" }).success).toBe(false);
  });

  /** An activity still has to anchor to exactly one thing. */
  it("refuses an activity with no anchor at all", () => {
    expect(createActivitySchema.safeParse(base).success).toBe(false);
  });
});
