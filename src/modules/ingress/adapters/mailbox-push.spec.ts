import { readPush, signatureMatches, signPayload } from "./mailbox-push";

const SECRET = "a-shared-secret-of-reasonable-length";
const body = JSON.stringify({ resource: "mailbox-42", provider: "gmail" });
const good = signPayload(SECRET, body);

describe("signatureMatches", () => {
  it("accepts the right signature", () => {
    expect(signatureMatches(good, good)).toBe(true);
  });

  it("rejects a wrong one", () => {
    expect(signatureMatches(good, signPayload("other-secret", body))).toBe(false);
  });

  /**
   * `timingSafeEqual` throws on a length mismatch, which is itself a leak, so
   * lengths are compared first and unequal ones rejected without comparing.
   */
  it("rejects a different-length signature without throwing", () => {
    expect(() => signatureMatches(good, "short")).not.toThrow();
    expect(signatureMatches(good, "short")).toBe(false);
  });

  it("rejects a missing signature", () => {
    expect(signatureMatches(good, undefined)).toBe(false);
  });
});

describe("readPush", () => {
  it("reads a signed notification", () => {
    expect(readPush(body, good, SECRET, JSON.parse(body))).toEqual({
      ok: true,
      notification: { resource: "mailbox-42", provider: "gmail" },
    });
  });

  it("refuses an unsigned or wrongly signed body", () => {
    expect(readPush(body, undefined, SECRET, JSON.parse(body))).toEqual({
      ok: false,
      reason: "bad-signature",
    });
    expect(readPush(body, "deadbeef", SECRET, JSON.parse(body)).ok).toBe(false);
  });

  /**
   * The signature covers the exact bytes. A body altered after signing — a
   * different mailbox id, say — must not verify.
   */
  it("refuses a body that changed after it was signed", () => {
    const tampered = JSON.stringify({ resource: "mailbox-99", provider: "gmail" });
    expect(readPush(tampered, good, SECRET, JSON.parse(tampered)).ok).toBe(false);
  });

  it("refuses a malformed payload", () => {
    for (const payload of [null, "text", 42, {}, { resource: "  " }]) {
      const raw = JSON.stringify(payload);
      expect(readPush(raw, signPayload(SECRET, raw), SECRET, payload).ok).toBe(false);
    }
  });

  it("refuses a provider it does not serve", () => {
    const raw = JSON.stringify({ resource: "m", provider: "carrier-pigeon" });
    expect(readPush(raw, signPayload(SECRET, raw), SECRET, JSON.parse(raw))).toEqual({
      ok: false,
      reason: "unknown-provider",
    });
  });

  /**
   * The notification carries no message content and no organisation, by
   * design. It only ever triggers a sweep that reads from the provider over an
   * authenticated connection — otherwise anybody who guessed a mailbox id
   * could write whatever they liked into a customer's timeline.
   */
  it("yields only a mailbox reference, never content or a tenant", () => {
    const raw = JSON.stringify({
      resource: "mailbox-42",
      provider: "gmail",
      organizationId: "someone-elses-org",
      subject: "Injected",
      body: "Injected",
    });
    const verdict = readPush(raw, signPayload(SECRET, raw), SECRET, JSON.parse(raw));
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(Object.keys(verdict.notification).sort()).toEqual(["provider", "resource"]);
  });
});
