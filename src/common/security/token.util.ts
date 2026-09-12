import { createHash, timingSafeEqual } from "node:crypto";

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Whether a stored digest equals the digest of what was presented, compared
 * in constant time. `===` on two hex digests returns at the first differing
 * character, and a stored digest is exactly the value that must not be
 * narrowed one character at a time. A missing digest never matches.
 */
export function digestsMatch(stored: string | null | undefined, presented: string): boolean {
  if (!stored) return false;
  const left = Buffer.from(stored, "utf8");
  const right = Buffer.from(presented, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
