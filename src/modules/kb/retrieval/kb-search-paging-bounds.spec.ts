import { searchSchema } from "./dto/kb-ai.schemas";

describe("KB search schema bounds (offset/page retired — top-N only)", () => {
  const MAX_PAGE_SIZE = 50;

  const parse = (query: Record<string, string | undefined>) => searchSchema.parse({ q: "expense", ...query });

  it("accepts an in-range pageSize", () => {
    expect(parse({ pageSize: "10" }).pageSize).toBe(10);
    expect(parse({ pageSize: "1" }).pageSize).toBe(1);
    expect(parse({ pageSize: String(MAX_PAGE_SIZE) }).pageSize).toBe(MAX_PAGE_SIZE);
  });

  it("clamps pageSize at the cap so a caller asking for more still gets a bounded read", () => {
    expect(parse({ pageSize: String(MAX_PAGE_SIZE + 1) }).pageSize).toBe(MAX_PAGE_SIZE);
    expect(parse({ pageSize: "9999" }).pageSize).toBe(MAX_PAGE_SIZE);
  });

  it("still rejects a pageSize below one", () => {
    expect(() => parse({ pageSize: "0" })).toThrow();
    expect(() => parse({ pageSize: "-5" })).toThrow();
  });

  it("rejects the legacy page field as an unknown key because the endpoint no longer paginates by offset", () => {
    expect(() => searchSchema.parse({ q: "expense", page: "1", pageSize: "10" })).toThrow();
  });

  it("control: the rejection is from strict unknown-key handling, not from the page value being invalid", () => {
    expect(() => searchSchema.parse({ q: "expense", pageSize: "10" })).not.toThrow();
  });
});

describe("KB search schema — cursor field (keyset pagination)", () => {
  it("accepts a cursor string so a client can continue from where it left off", () => {
    const result = searchSchema.parse({ q: "leave", cursor: "abc123" });
    expect(result.cursor).toBe("abc123");
  });

  it("cursor is optional — a first-page request with no cursor still parses correctly", () => {
    const result = searchSchema.parse({ q: "leave" });
    expect(result.cursor).toBeUndefined();
  });

  it("rejects an empty-string cursor so a client cannot send a semantically invalid position", () => {
    expect(() => searchSchema.parse({ q: "leave", cursor: "" })).toThrow();
  });

  it("rejects a cursor over 512 characters so an inflated token cannot crash the decoder", () => {
    expect(() => searchSchema.parse({ q: "leave", cursor: "a".repeat(513) })).toThrow();
  });

  it("accepts a cursor at the 512-character boundary — exact limit is inclusive", () => {
    const result = searchSchema.parse({ q: "leave", cursor: "a".repeat(512) });
    expect(result.cursor).toHaveLength(512);
  });
});
