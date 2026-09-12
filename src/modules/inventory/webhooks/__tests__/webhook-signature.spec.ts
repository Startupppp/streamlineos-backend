import { createHmac } from "node:crypto";
import {
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
  signWebhookPayload,
  verifyWebhookSignature,
  webhookSignatureHeaderValue,
  webhookSignaturePreimage,
} from "../webhook-signature";

/**
 * E7. What the old scheme could not express, and what the new one must.
 *
 * The emitter signed the body and nothing else — `HMAC(secret, body)` under
 * `X-Inventory-Signature: sha256=…`. Every assertion here that mentions a
 * timestamp is one the old scheme could not have passed, because it had no
 * concept the receiver could check freshness against.
 */
describe("inventory webhook signatures", () => {
  const secret = "a".repeat(64);
  const body = JSON.stringify({ id: "42", type: "inventory.stock.changed", data: { sku: "X-1" } });
  const now = 1_788_134_400;

  it("verifies a signature this module just produced", () => {
    const header = webhookSignatureHeaderValue(secret, now, body);

    expect(verifyWebhookSignature({ secret, header, rawBody: body, nowSeconds: now })).toEqual({
      valid: true,
    });
  });

  it("covers the timestamp as well as the body", () => {
    // The property the old scheme lacked, stated directly: the digest is a
    // function of both halves, so neither can be swapped without the secret.
    expect(signWebhookPayload(secret, now, body)).not.toBe(
      signWebhookPayload(secret, now + 1, body),
    );
    expect(webhookSignaturePreimage(now, body)).toBe(`${now}.${body}`);
    expect(signWebhookPayload(secret, now, body)).toBe(
      createHmac("sha256", secret).update(`${now}.${body}`).digest("hex"),
    );
  });

  it("refuses a replayed delivery once the timestamp leaves the window", () => {
    // A capture of a genuine delivery: the signature is real and the body is
    // untouched. Under the old scheme this verified forever.
    const header = webhookSignatureHeaderValue(secret, now, body);

    expect(
      verifyWebhookSignature({
        secret,
        header,
        rawBody: body,
        nowSeconds: now + WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS + 1,
      }),
    ).toEqual({ valid: false, reason: "timestamp-outside-window" });

    // Still inside the tolerance, so a slow hop is not treated as an attack.
    expect(
      verifyWebhookSignature({
        secret,
        header,
        rawBody: body,
        nowSeconds: now + WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
      }),
    ).toEqual({ valid: true });
  });

  it("refuses a timestamp far in the future as well as far in the past", () => {
    const header = webhookSignatureHeaderValue(secret, now + 3_600, body);

    expect(verifyWebhookSignature({ secret, header, rawBody: body, nowSeconds: now })).toEqual({
      valid: false,
      reason: "timestamp-outside-window",
    });
  });

  it("refuses a fresh timestamp pasted onto an old signature", () => {
    // The other half of a replay: keep the digest, move the clock forward so the
    // window check passes. The preimage changed, so the digest no longer matches.
    const captured = signWebhookPayload(secret, now, body);
    const header = `t=${now + 60},v1=${captured}`;

    expect(
      verifyWebhookSignature({ secret, header, rawBody: body, nowSeconds: now + 60 }),
    ).toEqual({ valid: false, reason: "signature-mismatch" });
  });

  it("refuses a tampered body", () => {
    const header = webhookSignatureHeaderValue(secret, now, body);

    expect(
      verifyWebhookSignature({
        secret,
        header,
        rawBody: body.replace("X-1", "X-2"),
        nowSeconds: now,
      }),
    ).toEqual({ valid: false, reason: "signature-mismatch" });
  });

  it("refuses the wrong secret", () => {
    const header = webhookSignatureHeaderValue("b".repeat(64), now, body);

    expect(verifyWebhookSignature({ secret, header, rawBody: body, nowSeconds: now })).toEqual({
      valid: false,
      reason: "signature-mismatch",
    });
  });

  it("does not throw on a signature of the wrong length", () => {
    // timingSafeEqual throws on a length mismatch; a receiver must get a verdict,
    // not an exception, from a header an attacker fully controls.
    expect(
      verifyWebhookSignature({ secret, header: `t=${now},v1=deadbeef`, rawBody: body, nowSeconds: now }),
    ).toEqual({ valid: false, reason: "signature-mismatch" });
  });

  it("names a scheme it does not know rather than calling it malformed", () => {
    expect(
      verifyWebhookSignature({ secret, header: `t=${now},v2=abc`, rawBody: body, nowSeconds: now }),
    ).toEqual({ valid: false, reason: "unsupported-version" });
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["the old body-only scheme", "sha256=abc123"],
    ["timestamp only", "t=1788134400"],
    ["non-numeric timestamp", "t=now,v1=abc"],
    ["non-hex signature", "t=1788134400,v1=zzzz"],
  ])("rejects a %s signature header", (_label, header) => {
    expect(
      verifyWebhookSignature({ secret, header, rawBody: body, nowSeconds: now }),
    ).toEqual({ valid: false, reason: "malformed-signature" });
  });

  it("tolerates whitespace and ordering in the header", () => {
    const digest = signWebhookPayload(secret, now, body);

    expect(
      verifyWebhookSignature({
        secret,
        header: ` v1=${digest.toUpperCase()} , t=${now} `,
        rawBody: body,
        nowSeconds: now,
      }),
    ).toEqual({ valid: true });
  });
});
