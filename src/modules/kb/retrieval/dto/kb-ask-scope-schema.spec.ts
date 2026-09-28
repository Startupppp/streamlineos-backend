import { askSchema, KB_ASK_STATUS_SCOPES } from "./kb-ai.schemas";
import { KB_PAGE_STATUSES } from "../../core/collection/knowledge-collection.types";
import { kbScopeExcludesLinkedDocuments } from "../kb-ask-context";
import type { AskInput } from "./kb-ai.schemas";

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

  it("accepts every status Ask can actually retrieve, so no scope the candidate queries could honour is accidentally excluded", () => {
    for (const status of KB_ASK_STATUS_SCOPES) {
      const parsed = askSchema.safeParse({
        question: "what is the leave policy",
        status,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("rejects an archived scope outright rather than accepting it and returning nothing, because the candidate queries exclude archived unconditionally and a contract that accepts a value it can never honour reports an empty knowledge base instead of a bad request", () => {
    const parsed = askSchema.safeParse({
      question: "what is the leave policy",
      status: "archived",
    });

    expect(parsed.success).toBe(false);
  });

  it("offers exactly the page statuses minus archived, so adding a lifecycle state to the page catalogue fails here until someone decides whether Ask should retrieve it", () => {
    expect([...KB_ASK_STATUS_SCOPES]).toEqual(
      KB_PAGE_STATUSES.filter((s) => s !== "archived"),
    );
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

describe("kbScopeExcludesLinkedDocuments — ownerMembershipId and status cause exclusion", () => {
  const baseInput: AskInput = { question: "what is the leave policy" };

  it("returns true when ownerMembershipId is set so the linked-documents channel is skipped rather than returning unscoped company documents alongside owner-scoped KB pages", () => {
    expect(kbScopeExcludesLinkedDocuments({ ...baseInput, ownerMembershipId: 7 })).toBe(true);
  });

  it("returns false when ownerMembershipId is absent and no other scope is set, confirming linked documents are still eligible when no ownership restriction applies", () => {
    expect(kbScopeExcludesLinkedDocuments(baseInput)).toBe(false);
  });

  it("returns true when status is set so the linked-documents channel is skipped rather than returning unscoped company documents alongside status-filtered KB pages", () => {
    expect(kbScopeExcludesLinkedDocuments({ ...baseInput, status: "published" })).toBe(true);
  });

  it("returns false when status is absent and no other scope is set, confirming linked documents are still eligible when no status restriction applies", () => {
    expect(kbScopeExcludesLinkedDocuments(baseInput)).toBe(false);
  });

  it("returns true when both ownerMembershipId and status are set together", () => {
    expect(kbScopeExcludesLinkedDocuments({ ...baseInput, ownerMembershipId: 3, status: "draft" })).toBe(true);
  });
});
