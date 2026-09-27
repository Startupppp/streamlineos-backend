import { askSchema } from "./kb-ai.schemas";

describe("askSchema page scope", () => {
  it("rejects an empty pageIds array, because an empty IN list is dropped downstream and silently widens the search to every visible page", () => {
    const parsed = askSchema.safeParse({
      question: "what is the leave policy",
      pageIds: [],
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts a single page id, so narrowing to one page is still expressible", () => {
    const parsed = askSchema.safeParse({
      question: "what is the leave policy",
      pageIds: [7],
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts an omitted pageIds, because omitting the scope is how a caller asks across everything they can read", () => {
    const parsed = askSchema.safeParse({
      question: "what is the leave policy",
    });
    expect(parsed.success).toBe(true);
  });

  it("still caps pageIds at fifty", () => {
    const parsed = askSchema.safeParse({
      question: "what is the leave policy",
      pageIds: Array.from({ length: 51 }, (_, i) => i + 1),
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts exactly fifty page ids, so the cap is a boundary and not an off-by-one", () => {
    const parsed = askSchema.safeParse({
      question: "what is the leave policy",
      pageIds: Array.from({ length: 50 }, (_, i) => i + 1),
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a non-positive page id, because page ids are always positive integers", () => {
    const parsed = askSchema.safeParse({
      question: "what is the leave policy",
      pageIds: [0],
    });
    expect(parsed.success).toBe(false);
  });
});
