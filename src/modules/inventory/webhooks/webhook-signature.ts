import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * E7 — the signing scheme for outbound inventory webhooks.
 *
 * ## What it replaced, and why that was not enough
 *
 * The emitter used to send `X-Inventory-Signature: sha256=<hex>` over
 * `HMAC-SHA256(secret, body)` and nothing else. That proves the body was written
 * by someone holding the secret, and proves nothing about *when*. A recipient
 * capturing one (body, signature) pair — a proxy, a log, a mirrored request —
 * can post it back to the same endpoint any number of times, forever, and every
 * check the receiver can run still passes. The body did carry a `timestamp`
 * field, but a field inside a signed body is not a defence: it is signed once and
 * replayed with the rest of it, and nothing tells the receiver what age to
 * refuse.
 *
 * ## The scheme now
 *
 * The signature covers `"<unix seconds>.<raw body>"` and the timestamp travels
 * beside it, so the receiver can bound the age of what it accepts and a captured
 * request stops verifying once the window passes. Changing either half — replay
 * an old timestamp with a fresh body, or a fresh timestamp with an old body —
 * changes the preimage, so the attacker needs the secret to re-sign.
 *
 *   X-Inventory-Timestamp: 1788134400
 *   X-Inventory-Signature: t=1788134400,v1=<hex>
 *   X-Inventory-Event-Id:  4213
 *
 * `t=…,v1=…` is versioned on purpose: a second algorithm ships as `v2=` alongside
 * `v1=` and a receiver picks the strongest scheme it knows, rather than everyone
 * breaking on the same day.
 *
 * There is no back-compatible `sha256=` fallback, and it is safe not to have one:
 * A5 established that inventory webhooks had never fired at all, so no subscriber
 * has ever verified the old scheme. Accepting both would have preserved the replay
 * hole for the life of the product to protect zero integrations.
 *
 * ## Verification
 *
 * `verifyWebhookSignature` is the receiver's half. It is exported so our own
 * tests, the docs and any inbound bridge share one implementation rather than
 * each re-deriving the preimage, and it compares with `timingSafeEqual`: a
 * byte-by-byte `===` leaks how long a candidate signature's shared prefix is, and
 * a signature is exactly the kind of value an attacker gets unlimited guesses at.
 */

export const WEBHOOK_SIGNATURE_VERSION = "v1";

export const WEBHOOK_SIGNATURE_HEADER = "X-Inventory-Signature";
export const WEBHOOK_TIMESTAMP_HEADER = "X-Inventory-Timestamp";
export const WEBHOOK_EVENT_ID_HEADER = "X-Inventory-Event-Id";
export const WEBHOOK_EVENT_TYPE_HEADER = "X-Inventory-Event-Type";
export const WEBHOOK_ATTEMPT_HEADER = "X-Inventory-Delivery-Attempt";

/**
 * How far a delivery's timestamp may sit from the receiver's clock. Five minutes
 * is the industry default (Stripe, GitHub, Slack): wide enough for clock drift
 * and a slow hop, narrow enough that a captured request is worthless by the time
 * anyone reads a log.
 */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

export type WebhookSignatureRejection =
  | "malformed-signature"
  | "unsupported-version"
  | "timestamp-outside-window"
  | "signature-mismatch";

export type WebhookSignatureCheck =
  | { valid: true }
  | { valid: false; reason: WebhookSignatureRejection };

/**
 * The signed bytes. The timestamp is joined to the body with a separator that
 * cannot appear in the decimal timestamp, so `("1", "0.x")` and `("10", ".x")`
 * cannot produce the same preimage.
 */
export function webhookSignaturePreimage(timestampSeconds: number, rawBody: string): string {
  return `${timestampSeconds}.${rawBody}`;
}

export function signWebhookPayload(
  secret: string,
  timestampSeconds: number,
  rawBody: string,
): string {
  return createHmac("sha256", secret)
    .update(webhookSignaturePreimage(timestampSeconds, rawBody))
    .digest("hex");
}

export function webhookSignatureHeaderValue(
  secret: string,
  timestampSeconds: number,
  rawBody: string,
): string {
  return `t=${timestampSeconds},${WEBHOOK_SIGNATURE_VERSION}=${signWebhookPayload(secret, timestampSeconds, rawBody)}`;
}

function parseSignatureHeader(header: string): { t: number; v1: string } | null {
  let timestamp: number | null = null;
  let signature: string | null = null;

  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      if (!/^\d+$/.test(value)) return null;
      timestamp = Number(value);
    } else if (key === WEBHOOK_SIGNATURE_VERSION) {
      if (!/^[0-9a-f]+$/i.test(value)) return null;
      signature = value.toLowerCase();
    }
  }

  if (timestamp === null || signature === null) return null;
  return { t: timestamp, v1: signature };
}

/**
 * Constant-time verification of a delivery.
 *
 * Order matters: the timestamp window is checked *before* the digest, so a
 * replayed request is refused as `timestamp-outside-window` even when its
 * signature is genuine — which is the whole point of the scheme. Both failures
 * are equally fatal to the caller; the distinction exists so an operator reading
 * a log can tell a replay from a wrong secret.
 */
export function verifyWebhookSignature(input: {
  secret: string;
  header: string | null | undefined;
  rawBody: string;
  toleranceSeconds?: number;
  nowSeconds?: number;
}): WebhookSignatureCheck {
  if (!input.header) return { valid: false, reason: "malformed-signature" };

  const parsed = parseSignatureHeader(input.header);
  if (!parsed) {
    // A header that parses but names no scheme we know is a different failure
    // from one that is simply garbage: the sender is newer than the receiver.
    return {
      valid: false,
      reason: /(^|,)\s*v\d+=/.test(input.header) && !input.header.includes(`${WEBHOOK_SIGNATURE_VERSION}=`)
        ? "unsupported-version"
        : "malformed-signature",
    };
  }

  const tolerance = input.toleranceSeconds ?? WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  // Absolute, not one-sided: a timestamp far in the future is as much a forgery
  // signal as one far in the past, and accepting it would hand an attacker a
  // capture that stays valid until that future arrives.
  if (Math.abs(now - parsed.t) > tolerance) {
    return { valid: false, reason: "timestamp-outside-window" };
  }

  const expected = Buffer.from(signWebhookPayload(input.secret, parsed.t, input.rawBody), "utf-8");
  const provided = Buffer.from(parsed.v1, "utf-8");
  // timingSafeEqual throws on a length mismatch, and the length of a hex digest
  // is public, so compare it first rather than letting the throw escape.
  if (expected.length !== provided.length) {
    return { valid: false, reason: "signature-mismatch" };
  }
  return timingSafeEqual(expected, provided)
    ? { valid: true }
    : { valid: false, reason: "signature-mismatch" };
}
