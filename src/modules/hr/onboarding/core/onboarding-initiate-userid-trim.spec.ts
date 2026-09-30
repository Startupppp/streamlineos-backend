import { initiateSchema } from "./dto/onboarding.schemas";

/**
 * BUG-003's backend half. `z.string().min(1)` accepts `"   "`, so a
 * whitespace-only employee selection passed validation and was answered 404
 * "User not found in this organization" — a lookup miss reported for a request
 * that named nobody. Verified over a real request against a booted API before
 * this change: `""` returned 400 VALIDATION_FAILED, `"   "` returned 404.
 */
describe("onboarding initiate refuses a userId that is only whitespace", () => {
  it("accepts a real userId, so the refusals below are not passing on a schema that rejects everything", () => {
    const parsed = initiateSchema.safeParse({ userId: "user-123" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.userId).toBe("user-123");
  });

  it("refuses an empty userId", () => {
    expect(initiateSchema.safeParse({ userId: "" }).success).toBe(false);
  });

  it.each(["   ", "\t", "\n", " \t\n "])("refuses a userId of only whitespace (%j)", (userId) => {
    expect(initiateSchema.safeParse({ userId }).success).toBe(false);
  });

  it("trims the surrounding whitespace off a real userId rather than looking it up verbatim", () => {
    const parsed = initiateSchema.safeParse({ userId: "  user-123  " });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.userId).toBe("user-123");
  });
});
