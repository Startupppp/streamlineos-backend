import {
  MAX_BULK,
  assignFindingsSchema,
  findingSelectionSchema,
  listFindingsQuerySchema,
  resolveFindingsSchema,
  scanSchema,
  SWEEPABLE_PRODUCERS,
} from "./data-quality.schemas";

/**
 * Asserted against the schemas directly rather than over HTTP, for the reason
 * `autonomy-review.schemas.spec.ts` records: the tenant interceptor resolves an
 * organisation's region before a handler runs, so on a database missing a
 * migration every request 500s before validation is reached.
 */
describe("data quality schemas", () => {
  describe("selection", () => {
    it("accepts a list of identifiers", () => {
      const parsed = findingSelectionSchema.parse({ kind: "ids", findingIds: ["a", "b"] });
      expect(parsed).toEqual({ kind: "ids", findingIds: ["a", "b"] });
    });

    it("accepts a group", () => {
      expect(
        findingSelectionSchema.parse({ kind: "group", groupKey: "reachability:no-channel" }),
      ).toMatchObject({ kind: "group" });
    });

    /**
     * Four hundred is the ticket's own motivating case, so it has to fit. The cap
     * is on the payload rather than the decision: a larger group is worked in
     * successive decisions, and the response says how many are left.
     */
    it("takes the ticket's four hundred", () => {
      const findingIds = Array.from({ length: MAX_BULK }, (_, i) => `f-${i}`);
      expect(findingSelectionSchema.parse({ kind: "ids", findingIds }).kind).toBe("ids");
    });

    it("refuses more than the bulk cap", () => {
      const findingIds = Array.from({ length: MAX_BULK + 1 }, (_, i) => `f-${i}`);
      expect(() => findingSelectionSchema.parse({ kind: "ids", findingIds })).toThrow();
    });

    it("refuses an empty selection — a decision about nothing is not a decision", () => {
      expect(() => findingSelectionSchema.parse({ kind: "ids", findingIds: [] })).toThrow();
    });

    it("refuses a selection that names both shapes", () => {
      expect(() =>
        findingSelectionSchema.parse({ kind: "ids", findingIds: ["a"], groupKey: "x" }),
      ).toThrow();
    });
  });

  describe("list query", () => {
    it("shows the oldest first, because age is the point", () => {
      expect(listFindingsQuerySchema.parse({}).order).toBe("oldest");
    });

    it("defaults to open findings", () => {
      expect(listFindingsQuerySchema.parse({}).status).toBe("open");
    });

    /**
     * `z.coerce.boolean()` is `Boolean(value)`, so every non-empty string is
     * true and `?unassignedOnly=false` would silently mean the opposite.
     */
    it("reads a query-string false as false", () => {
      expect(listFindingsQuerySchema.parse({ unassignedOnly: "false" }).unassignedOnly).toBe(false);
      expect(listFindingsQuerySchema.parse({ unassignedOnly: "true" }).unassignedOnly).toBe(true);
    });

    it("lets the page be as large as one decision can cover", () => {
      expect(listFindingsQuerySchema.parse({ limit: String(MAX_BULK) }).limit).toBe(MAX_BULK);
      expect(() => listFindingsQuerySchema.parse({ limit: String(MAX_BULK + 1) })).toThrow();
    });

    it("refuses a filter it does not know", () => {
      expect(() => listFindingsQuerySchema.parse({ producr: "duplicate" })).toThrow();
    });
  });

  describe("resolve", () => {
    it("carries what the person believed they were deciding about", () => {
      const parsed = resolveFindingsSchema.parse({
        selection: { kind: "group", groupKey: "staleness:180d+" },
        action: "dismiss",
        expectedCount: 312,
      });
      expect(parsed.expectedCount).toBe(312);
    });

    /**
     * One decision covers at most `MAX_BULK`, so an expectation larger than that
     * could never be met — and quietly accepting it would make the guard useless
     * for exactly the group it exists to protect.
     */
    it("refuses an expectation larger than one decision can cover", () => {
      expect(() =>
        resolveFindingsSchema.parse({
          selection: { kind: "group", groupKey: "staleness:180d+" },
          action: "dismiss",
          expectedCount: MAX_BULK + 12,
        }),
      ).toThrow();
    });

    it("does not require an expected count", () => {
      const parsed = resolveFindingsSchema.parse({
        selection: { kind: "ids", findingIds: ["f-1"] },
        action: "apply",
      });
      expect(parsed.expectedCount).toBeUndefined();
    });

    it("refuses an action it has no executor for", () => {
      expect(() =>
        resolveFindingsSchema.parse({
          selection: { kind: "ids", findingIds: ["f-1"] },
          action: "merge",
        }),
      ).toThrow();
    });
  });

  describe("assignment", () => {
    it("accepts null, because handing work back has to be as easy as taking it", () => {
      const parsed = assignFindingsSchema.parse({
        selection: { kind: "ids", findingIds: ["f-1"] },
        assigneeUserId: null,
      });
      expect(parsed.assigneeUserId).toBeNull();
    });

    it("requires the field, so an omitted assignee is never read as un-assign", () => {
      expect(() =>
        assignFindingsSchema.parse({ selection: { kind: "ids", findingIds: ["f-1"] } }),
      ).toThrow();
    });
  });

  describe("scan", () => {
    /**
     * `import-uncertainty` is absent on purpose: the importer resolves every row
     * to a definite action and persists no uncertainty, so offering it would make
     * a sweep that reads nothing look like a dataset with no import problems.
     */
    it("offers only the producers that have an ingest", () => {
      expect([...SWEEPABLE_PRODUCERS]).toEqual([
        "duplicate",
        "contradiction",
        "reachability",
        "staleness",
      ]);
      expect(() => scanSchema.parse({ producers: ["import-uncertainty"] })).toThrow();
    });

    it("takes the staleness threshold as an argument, not a constant", () => {
      expect(scanSchema.parse({}).staleAfterDays).toBe(180);
      expect(scanSchema.parse({ staleAfterDays: 30 }).staleAfterDays).toBe(30);
    });

    it("refuses a threshold so short every record is stale", () => {
      expect(() => scanSchema.parse({ staleAfterDays: 1 })).toThrow();
    });
  });
});
