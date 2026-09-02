import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const HASH_PREFIX = "sha256:";

export function generateInboundSecret(): string {
  return randomBytes(24).toString("hex");
}

export function hashInboundSecret(secret: string): string {
  return `${HASH_PREFIX}${createHash("sha256").update(secret, "utf8").digest("hex")}`;
}

export function isHashedInboundSecret(stored: string): boolean {
  return stored.startsWith(HASH_PREFIX);
}

/**
 * Both sides are reduced to a fixed-width digest before comparison, so the buffers
 * handed to `timingSafeEqual` are always the same length and neither the secret's
 * bytes nor its length leak through how long the check took. A row still holding a
 * pre-hash plaintext secret is digested at read time, which is what lets the column
 * change format without a migration.
 */
export function inboundSecretMatches(
  stored: string | null | undefined,
  provided: string | null | undefined,
): boolean {
  const bothPresent = Boolean(stored) && Boolean(provided);
  const storedValue = stored ?? "";
  const storedDigest = isHashedInboundSecret(storedValue)
    ? storedValue
    : hashInboundSecret(storedValue);
  const providedDigest = hashInboundSecret(provided ?? "");
  return constantTimeEquals(storedDigest, providedDigest) && bothPresent;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}
