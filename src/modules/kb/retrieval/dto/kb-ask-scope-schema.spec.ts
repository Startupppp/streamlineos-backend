import { askSchema } from "./kb-ai.schemas";

describe("askSchema source scope", () => {
  it("rejects an empty sourceIds array, because an empty IN list is dropped downstream and silently widens the search to every accessible source", () => {
    const parsed = askSchema.safeParse({
      question: "what is the leave policy",
      sourceIds: [],
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts a single source id, so narrowing to one source is still expressible", () => {
    const parsed = askSchema.safeParse({
      question: "what is the leave policy",
      sourceIds: [7],
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts an omitted sourceIds, because omitting the scope is how a caller asks across everything they can read", () => {
    const parsed = askSchema.safeParse({
      question: "what is the leave policy",
    });
    expect(parsed.success).toBe(true);
  });

  it("still caps sourceIds at fifty", () => {
    const parsed = askSchema.safeParse({
      question: "what is the leave policy",
      sourceIds: Array.from({ length: 51 }, (_, i) => i + 1),
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts exactly fifty source ids, so the cap is a boundary and not an off-by-one", () => {
    const parsed = askSchema.safeParse({
      question: "what is the leave policy",
      sourceIds: Array.from({ length: 50 }, (_, i) => i + 1),
    });
    expect(parsed.success).toBe(true);
  });
});
