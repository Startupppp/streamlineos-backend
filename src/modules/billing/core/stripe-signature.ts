import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stripe's webhook signature, verified without the SDK.
 *
 * Phase 3, ticket 02. The seam rule for this phase is that providers are driven
 * from **fixtures**, not mocked SDKs -- so the verification has to be ours, or
 * every test of it would be a test of a mock agreeing with itself.
 *
 * The header looks like:
 *
 *     Stripe-Signature: t=1614556800,v1=5257a869e7...,v1=a1b2c3...
 *
 * and the signed payload is `${timestamp}.${rawBody}`, HMAC-SHA256 with the
 * endpoint secret. Three things make this different from Razorpay's, and each
 * of them is a real attack if skipped:
 *
 *   **The timestamp is inside the signature.** Signing the body alone means a
 *   captured webhook can be replayed forever. It is signed here and checked
 *   against a tolerance below.
 *
 *   **There can be several `v1` values.** During a secret rotation Stripe signs
 *   with both, so accepting only the first breaks every delivery in the rotation
 *   window -- which is exactly when you least want the billing webhook down.
 *
 *   **The comparison must be constant-time**, and `timingSafeEqual` throws on a
 *   length mismatch rather than returning false, so lengths are checked first.
 */

/**
 * How old a delivery may be.
 *
 * Stripe's own guidance is five minutes. Long enough to survive a retry and a
 * slow queue; short enough that a captured request is not a standing key.
 */
export const REPLAY_TOLERANCE_SECONDS = 300;

export interface StripeSignatureHeader {
  readonly timestamp: number;
  readonly signatures: readonly string[];
}

/**
 * Splits the header, and refuses anything it cannot read.
 *
 * Returns null rather than throwing: a malformed header is an untrusted input,
 * not an exceptional condition, and every caller's response is the same.
 */
export function parseStripeSignature(header: string): StripeSignatureHeader | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of header.split(",")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    if (key === "t") {
      const parsed = Number(value);
      // Integer seconds. A float or a string here means the header was not
      // produced by Stripe, and coercing it would be inventing a timestamp.
      if (!Number.isInteger(parsed) || parsed <= 0) return null;
      timestamp = parsed;
    } else if (key === "v1") {
      if (value.length > 0) signatures.push(value);
    }
    // v0 is the test-mode scheme and is deliberately ignored: accepting it in
    // production would let a test-mode key sign a live event.
  }

  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

function constantTimeEquals(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export interface VerifyStripeWebhookParams {
  readonly rawBody: string;
  readonly header: string;
  readonly secret: string;
  /** Seconds since epoch. Passed in so the check is testable without a clock. */
  readonly now: number;
  readonly toleranceSeconds?: number;
}

export function verifyStripeWebhook({
  rawBody,
  header,
  secret,
  now,
  toleranceSeconds = REPLAY_TOLERANCE_SECONDS,
}: VerifyStripeWebhookParams): boolean {
  if (!secret) return false;

  const parsed = parseStripeSignature(header);
  if (!parsed) return false;

  /**
   * Outside the window in either direction.
   *
   * Future-dated deliveries are refused too. A signature valid for the next hour
   * because a clock is wrong is the replay window reopened from the other side,
   * and it is the case nobody writes a test for.
   */
  const age = now - parsed.timestamp;
  if (age > toleranceSeconds || age < -toleranceSeconds) return false;

  const expected = createHmac("sha256", secret)
    .update(`${parsed.timestamp}.${rawBody}`)
    .digest("hex");

  // Every candidate is compared, so a rotation window does not drop deliveries.
  return parsed.signatures.some((signature) => constantTimeEquals(expected, signature));
}
