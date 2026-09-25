import { searchSchema } from "./dto/kb-ai.schemas";
import { pageNumberField } from "../../../common/pagination/list-query.schema";

describe("KB search paging is bounded", () => {
  const MAX_PAGE = 200;
  const MAX_PAGE_SIZE = 50;

  const parse = (query: Record<string, string>) => searchSchema.parse({ q: "expense", ...query });

  it("leaves an ordinary page alone", () => {
    expect(parse({ page: "1" }).page).toBe(1);
    expect(parse({ page: "7" }).page).toBe(7);
    expect(parse({ page: String(MAX_PAGE) }).page).toBe(MAX_PAGE);
  });

  it("clamps rather than rejecting, so a bookmarked deep link still returns a page", () => {
    expect(parse({ page: String(MAX_PAGE + 1) }).page).toBe(MAX_PAGE);
    expect(parse({ page: "100000000" }).page).toBe(MAX_PAGE);
    expect(() => parse({ page: "100000000" })).not.toThrow();
  });

  it("bounds the offset the service computes, whatever the caller asks for", () => {
    const input = parse({ page: "100000000", pageSize: "500" });
    const offset = (input.page - 1) * input.pageSize;
    expect(input.pageSize).toBe(MAX_PAGE_SIZE);
    expect(offset).toBe((MAX_PAGE - 1) * MAX_PAGE_SIZE);
    expect(offset).toBeLessThanOrEqual(10_000);
  });

  it("still rejects a page below one", () => {
    expect(() => parse({ page: "0" })).toThrow();
    expect(() => parse({ page: "-3" })).toThrow();
  });

  it("does not change the platform field other modules share", () => {
    expect(pageNumberField.parse("100000000")).toBe(100_000_000);
  });
});
