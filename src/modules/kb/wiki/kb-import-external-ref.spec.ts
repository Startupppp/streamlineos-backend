import { importItemSchema } from "./dto/kb-import-export.schemas";

const TITLE = "Onboarding guide";

describe("importItemSchema — external reference pairing", () => {
  it("accepts an item carrying neither half of the external reference", () => {
    const parsed = importItemSchema.safeParse({ title: TITLE });
    expect(parsed.success).toBe(true);
  });

  it("accepts an item carrying both halves, which is the shape the unique index can match on", () => {
    const parsed = importItemSchema.safeParse({
      title: TITLE,
      externalId: "doc-42",
      externalSource: "confluence",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an externalId with no externalSource, because a null source makes the index key distinct on every re-import", () => {
    const parsed = importItemSchema.safeParse({ title: TITLE, externalId: "doc-42" });
    expect(parsed.success).toBe(false);
  });

  it("rejects an externalSource with no externalId, because the partial index never indexes the row", () => {
    const parsed = importItemSchema.safeParse({ title: TITLE, externalSource: "confluence" });
    expect(parsed.success).toBe(false);
  });

  it("reports the failure against externalSource so the caller is told which half is missing", () => {
    const parsed = importItemSchema.safeParse({ title: TITLE, externalId: "doc-42" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.path.includes("externalSource"))).toBe(true);
  });
});
