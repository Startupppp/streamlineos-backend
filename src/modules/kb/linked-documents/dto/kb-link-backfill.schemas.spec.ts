import { backfillInputSchema } from "./kb-link-backfill.schemas";

describe("backfill input", () => {
  it("is a dry run from the first page unless the caller says otherwise", () => {
    expect(backfillInputSchema.parse({})).toEqual({ dryRun: true, cursor: 0, limit: 100 });
  });

  it("changes something only when told, in so many words", () => {
    expect(backfillInputSchema.parse({ dryRun: false }).dryRun).toBe(false);
    expect(() => backfillInputSchema.parse({ dryRun: "false" })).toThrow();
    expect(() => backfillInputSchema.parse({ dryRun: 0 })).toThrow();
  });

  it("caps a page at the list limit and refuses a negative cursor", () => {
    expect(() => backfillInputSchema.parse({ limit: 101 })).toThrow();
    expect(() => backfillInputSchema.parse({ limit: 0 })).toThrow();
    expect(() => backfillInputSchema.parse({ cursor: -1 })).toThrow();
  });

  it("refuses anything it does not know, such as a organisation or a document list to change", () => {
    expect(() => backfillInputSchema.parse({ orgId: "other" })).toThrow();
    expect(() => backfillInputSchema.parse({ documentIds: [1] })).toThrow();
  });
});
