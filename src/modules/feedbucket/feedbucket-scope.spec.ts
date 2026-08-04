import { type SQL } from "drizzle-orm";
import { applyFeedbucketScope } from "./feedbucket-scope";

function isSqlLiteral(s: SQL, literal: string): boolean {
  const first: unknown = s.queryChunks[0];
  if (first == null || typeof first !== "object" || !("value" in first)) return false;
  const value = (first as { value: unknown }).value;
  if (!Array.isArray(value)) return false;
  return (value as unknown[])[0] === literal;
}

function isSqlFalse(s: SQL): boolean {
  return s.queryChunks.length === 1 && isSqlLiteral(s, "false");
}

function isSqlTrue(s: SQL): boolean {
  return s.queryChunks.length === 1 && isSqlLiteral(s, "true");
}

describe("applyFeedbucketScope", () => {
  const userId = "user-abc";

  it("returns sql`false` for none scope", () => {
    expect(isSqlFalse(applyFeedbucketScope("none", "org-a", userId))).toBe(true);
  });

  it("returns sql`true` for all scope", () => {
    expect(isSqlTrue(applyFeedbucketScope("all", "org-a", userId))).toBe(true);
  });

  it("does not widen team scope to every row", () => {
    expect(isSqlTrue(applyFeedbucketScope("team", "org-a", userId))).toBe(false);
  });

  it("does not widen own scope to every row", () => {
    expect(isSqlTrue(applyFeedbucketScope("own", "org-a", userId))).toBe(false);
  });
});
