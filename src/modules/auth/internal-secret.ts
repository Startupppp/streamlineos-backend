import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Both sides are reduced to a fixed-width sha256 digest before comparison — the
 * shape `support-inbound-secret.ts` established — so the buffers handed to
 * `timingSafeEqual` are always 32 bytes, and neither the configured secret's
 * bytes nor its *length* is observable through how long the check took. A plain
 * `!==` on the raw strings leaks both.
 */
export function internalSecretMatches(
  configured: string | undefined | null,
  presented: unknown,
): boolean {
  const configuredValue = typeof configured === "string" ? configured : "";
  const presentedValue = typeof presented === "string" ? presented : "";
  const bothPresent = configuredValue.length > 0 && presentedValue.length > 0;
  const equal = timingSafeEqual(digest(configuredValue), digest(presentedValue));
  return equal && bothPresent;
}
