import { searchSchema } from "./dto/kb-ai.schemas";

describe("KB search schema bounds (offset/page retired — top-N only)", () => {
  const MAX_PAGE_SIZE = 50;

  const parse = (query: Record<string, string>) => searchSchema.parse({ q: "expense", ...query });

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
