import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Accepting a provider's push notification, safely.
 *
 * A push endpoint is unauthenticated by nature — the provider has no session —
 * so everything it says is untrusted until the signature is checked. Two rules
 * follow, and both are about what the notification is NOT allowed to do.
 *
 * It may not carry data. Gmail and Graph both send "something changed for this
 * mailbox", and treating the body as the message would let anybody who guessed
 * a mailbox id write whatever they liked into a customer's timeline. The
 * notification only ever triggers a sweep, which reads from the provider over
 * an authenticated connection.
 *
 * And it may not name an organisation. The mailbox identifier is looked up, and
 * the tenant comes from that row — never from the request.
 */

export interface PushNotification {
  /** The provider's own identifier for the mailbox. */
  readonly resource: string;
  readonly provider: "gmail" | "outlook";
}

export type PushVerdict =
  | { readonly ok: true; readonly notification: PushNotification }
  | { readonly ok: false; readonly reason: "bad-signature" | "malformed" | "unknown-provider" };

/** A SHA-256 digest as `signPayload` writes one. */
const HEX_DIGEST = /^[0-9a-f]{64}$/;

/**
 * Constant-time comparison of the signature.
 *
 * `===` on a secret leaks its prefix through timing. `timingSafeEqual` throws
 * on a length mismatch, which is itself a leak, so anything that is not a
 * signature is rejected before it gets there.
 *
 * Shape first, and by bytes rather than by characters. Comparing
 * `provided.length` against a 64-character digest counts UTF-16 code units,
 * while `timingSafeEqual` is handed UTF-8 buffers — so a header of 64 multibyte
 * characters passed the length check and then threw `RangeError` out of an
 * unauthenticated endpoint. A 500 and a stack trace where this deliberately
 * returns a silent `bad-signature`, and trivially reachable: the header is
 * whatever the caller sends. The digest is hex by construction, so requiring
 * that is both the cheapest check and the exact one.
 */
export function signatureMatches(expected: string, provided: string | undefined): boolean {
  if (typeof provided !== "string" || !HEX_DIGEST.test(provided)) return false;

  const expectedBytes = Buffer.from(expected, "utf8");
  const providedBytes = Buffer.from(provided, "utf8");

  // Belt and braces: a future caller passing something other than a digest as
  // `expected` must not be able to throw either.
  if (expectedBytes.length !== providedBytes.length) return false;

  return timingSafeEqual(expectedBytes, providedBytes);
}

export function signPayload(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/**
 * What the notification is, or why it is being ignored.
 *
 * Silence rather than an error for a bad signature: a push endpoint that
 * distinguishes "wrong signature" from "unknown mailbox" tells an attacker
 * which mailboxes exist.
 */
export function readPush(
  rawBody: string,
  signature: string | undefined,
  secret: string,
  parsed: unknown,
): PushVerdict {
  if (!signatureMatches(signPayload(secret, rawBody), signature))
    return { ok: false, reason: "bad-signature" };

  if (typeof parsed !== "object" || parsed === null) return { ok: false, reason: "malformed" };

  const body = parsed as Record<string, unknown>;
  const resource = typeof body.resource === "string" ? body.resource.trim() : "";
  const provider = body.provider;

  if (!resource) return { ok: false, reason: "malformed" };
  if (provider !== "gmail" && provider !== "outlook")
    return { ok: false, reason: "unknown-provider" };

  return { ok: true, notification: { resource, provider } };
}
