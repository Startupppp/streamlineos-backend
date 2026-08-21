import {
  BULK_DEAL_ID_LIMIT,
  dealBulkDeleteSchema,
  dealBulkUpdateSchema,
} from "./deals.schemas";

describe("dealBulkUpdateSchema", () => {
  it("accepts a stage-only or assignee-only update", () => {
    expect(dealBulkUpdateSchema.parse({ dealIds: [1], update: { stage: "WON" } }).update.stage).toBe("WON");
    expect(
      dealBulkUpdateSchema.parse({ dealIds: [1], update: { assignedToId: "u1" } }).update.assignedToId,
    ).toBe("u1");
  });

  it("rejects an empty update, which would rewrite rows to no effect", () => {
    expect(() => dealBulkUpdateSchema.parse({ dealIds: [1], update: {} })).toThrow();
  });

  it("requires at least one id", () => {
    expect(() => dealBulkUpdateSchema.parse({ dealIds: [], update: { stage: "WON" } })).toThrow();
  });

  it("caps the id list so one request cannot rewrite the whole tenant", () => {
    const tooMany = Array.from({ length: BULK_DEAL_ID_LIMIT + 1 }, (_, i) => i + 1);
    expect(() => dealBulkUpdateSchema.parse({ dealIds: tooMany, update: { stage: "WON" } })).toThrow();
    expect(BULK_DEAL_ID_LIMIT).toBe(200);
  });

  it("rejects unknown update fields, so a caller cannot patch an unlisted column", () => {
    expect(() =>
      dealBulkUpdateSchema.parse({ dealIds: [1], update: { stage: "WON", orgId: "other" } }),
    ).toThrow();
  });

  it("rejects non-positive ids", () => {
    expect(() => dealBulkUpdateSchema.parse({ dealIds: [0], update: { stage: "WON" } })).toThrow();
    expect(() => dealBulkUpdateSchema.parse({ dealIds: [-1], update: { stage: "WON" } })).toThrow();
  });
});

describe("dealBulkDeleteSchema", () => {
  it("accepts a bounded id list", () => {
    expect(dealBulkDeleteSchema.parse({ dealIds: [1, 2, 3] }).dealIds).toHaveLength(3);
  });

  it("applies the same cap and minimum as bulk update", () => {
    expect(() => dealBulkDeleteSchema.parse({ dealIds: [] })).toThrow();
    expect(() =>
      dealBulkDeleteSchema.parse({
        dealIds: Array.from({ length: BULK_DEAL_ID_LIMIT + 1 }, (_, i) => i + 1),
      }),
    ).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() => dealBulkDeleteSchema.parse({ dealIds: [1], hard: true })).toThrow();
  });
});
