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

describe("feedbucket stats scope adapter", () => {
  const userId = "user-stats";

  it("stats aggregate must not use unscoped all when team is granted", () => {
    expect(isSqlTrue(applyFeedbucketScope("team", "org-a", userId))).toBe(false);
  });

  it("stats aggregate must deny none scope", () => {
    expect(isSqlFalse(applyFeedbucketScope("none", "org-a", userId))).toBe(true);
  });
});
