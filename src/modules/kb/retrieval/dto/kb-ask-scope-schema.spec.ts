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

describe("askSchema owner scope", () => {
  it("accepts a positive ownerMembershipId so a caller can narrow Ask to pages owned by a specific member", () => {
    const parsed = askSchema.safeParse({
      question: "what is the leave policy",
      ownerMembershipId: 42,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts an omitted ownerMembershipId, because omitting the scope is how a caller asks across all accessible pages regardless of owner", () => {
    const parsed = askSchema.safeParse({
      question: "what is the leave policy",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects ownerMembershipId of zero, because membership ids are positive integers and zero would silently match no owner", () => {
    const parsed = askSchema.safeParse({
      question: "what is the leave policy",
      ownerMembershipId: 0,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a negative ownerMembershipId for the same reason a zero is rejected", () => {
    const parsed = askSchema.safeParse({
      question: "what is the leave policy",
      ownerMembershipId: -5,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("askSchema status scope", () => {
  it("accepts a valid status value so a caller can narrow Ask to pages with a specific lifecycle state", () => {
    const parsed = askSchema.safeParse({
      question: "what is the leave policy",
      status: "published",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts every status the schema declares so no valid status is accidentally excluded", () => {
    const statuses = ["draft", "in_review", "published", "archived"] as const;
    for (const status of statuses) {
      const parsed = askSchema.safeParse({
        question: "what is the leave policy",
        status,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("accepts an omitted status, because omitting the scope is how a caller asks across all lifecycle states they can read", () => {
    const parsed = askSchema.safeParse({
      question: "what is the leave policy",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unrecognised status string so the schema stays strict and a typo does not silently widen the query to everything", () => {
    const parsed = askSchema.safeParse({
      question: "what is the leave policy",
      status: "deleted",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown field next to status because the schema is strict and extra keys indicate a caller mistake", () => {
    const parsed = askSchema.safeParse({
      question: "what is the leave policy",
      status: "published",
      unknownField: true,
    });
    expect(parsed.success).toBe(false);
  });
});
