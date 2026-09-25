import {
  APPROVE_COMMENT_MAX_LENGTH,
  approveLeaveSchema,
  rejectLeaveSchema,
} from "./leaves.schemas";

describe("approveLeaveSchema — optional manager comment (decision #8, PROVISIONAL)", () => {
  it("accepts an approval with no comment at all", () => {
    const parsed = approveLeaveSchema.parse({});
    expect(parsed.comment).toBeUndefined();
  });

  it("trims the comment before it reaches the handler", () => {
    const parsed = approveLeaveSchema.parse({ comment: "  Enjoy the break  " });
    expect(parsed.comment).toBe("Enjoy the break");
  });

  it("treats a whitespace-only comment as no comment, never as an empty string", () => {
    const parsed = approveLeaveSchema.parse({ comment: "   \n  " });
    expect(parsed.comment).toBeUndefined();
  });

  it("treats an explicit null as no comment", () => {
    const parsed = approveLeaveSchema.parse({ comment: null });
    expect(parsed.comment).toBeUndefined();
  });

  it("caps the comment length", () => {
    expect(APPROVE_COMMENT_MAX_LENGTH).toBe(2000);
    expect(
      approveLeaveSchema.safeParse({ comment: "x".repeat(APPROVE_COMMENT_MAX_LENGTH) })
        .success,
    ).toBe(true);
    const tooLong = approveLeaveSchema.safeParse({
      comment: "x".repeat(APPROVE_COMMENT_MAX_LENGTH + 1),
    });
    expect(tooLong.success).toBe(false);
  });

  it("rejects a non-string comment rather than coercing it", () => {
    expect(approveLeaveSchema.safeParse({ comment: 42 }).success).toBe(false);
  });

  it("stays strict about unknown keys (BE-13)", () => {
    expect(
      approveLeaveSchema.safeParse({ comment: "ok", managerComment: "sneaky" }).success,
    ).toBe(false);
  });
});

describe("rejectLeaveSchema — the required reason is unchanged by decision #8", () => {
  it("still refuses a rejection with no reason", () => {
    expect(rejectLeaveSchema.safeParse({}).success).toBe(false);
  });

  it("still refuses an empty reason", () => {
    const result = rejectLeaveSchema.safeParse({ reason: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("Rejection reason is required.");
    }
  });

  it("accepts a rejection carrying its reason", () => {
    const parsed = rejectLeaveSchema.parse({ reason: "Conflicting deadlines" });
    expect(parsed.reason).toBe("Conflicting deadlines");
  });
});
