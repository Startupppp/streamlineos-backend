import { createHmac } from "node:crypto";
import {
  parseStripeSignature,
  verifyStripeWebhook,
  REPLAY_TOLERANCE_SECONDS,
} from "./stripe-signature";

const SECRET = "whsec_testsecret";
const NOW = 1_614_556_800;

/** The real construction, so a wrong implementation cannot agree with itself. */
function sign(body: string, timestamp = NOW, secret = SECRET): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

const BODY = JSON.stringify({
  id: "evt_1",
  type: "payment_intent.succeeded",
  data: { object: { id: "pi_1", amount: 1900, currency: "eur" } },
});

describe("verifyStripeWebhook", () => {
  it("accepts a delivery Stripe actually signed", () => {
    expect(
      verifyStripeWebhook({ rawBody: BODY, header: sign(BODY), secret: SECRET, now: NOW }),
    ).toBe(true);
  });

  it("refuses a body that was altered after signing", () => {
    const header = sign(BODY);
    const tampered = BODY.replace('"amount":1900', '"amount":1');

    expect(
      verifyStripeWebhook({ rawBody: tampered, header, secret: SECRET, now: NOW }),
    ).toBe(false);
  });

  it("refuses a signature made with a different secret", () => {
    const header = sign(BODY, NOW, "whsec_someoneelse");

    expect(
      verifyStripeWebhook({ rawBody: BODY, header, secret: SECRET, now: NOW }),
    ).toBe(false);
  });

  /**
   * The attack signing the body alone would allow.
   *
   * A captured delivery would otherwise stay valid forever, so anyone who ever
   * saw one request could re-credit an account at will.
   */
  it("refuses a delivery replayed after the tolerance", () => {
    const header = sign(BODY, NOW);

    expect(
      verifyStripeWebhook({
        rawBody: BODY,
        header,
        secret: SECRET,
        now: NOW + REPLAY_TOLERANCE_SECONDS + 1,
      }),
    ).toBe(false);
  });

  it("accepts one still inside the tolerance, so a retry is not lost", () => {
    expect(
      verifyStripeWebhook({
        rawBody: BODY,
        header: sign(BODY, NOW),
        secret: SECRET,
        now: NOW + REPLAY_TOLERANCE_SECONDS - 1,
      }),
    ).toBe(true);
  });

  /**
   * The same window from the other side, which nobody writes a test for.
   *
   * A future-dated signature is the replay window reopened: with a skewed clock
   * it stays valid for as long as the skew lasts.
   */
  it("refuses a future-dated delivery", () => {
    expect(
      verifyStripeWebhook({
        rawBody: BODY,
        header: sign(BODY, NOW + REPLAY_TOLERANCE_SECONDS + 60),
        secret: SECRET,
        now: NOW,
      }),
    ).toBe(false);
  });

  /**
   * Rotation, which is when you least want the billing webhook down.
   *
   * Stripe signs with the old and new secrets at once while a secret is being
   * rotated. Checking only the first `v1` drops every delivery in that window.
   */
  it("accepts a delivery whose matching signature is not the first", () => {
    const good = createHmac("sha256", SECRET).update(`${NOW}.${BODY}`).digest("hex");
    const header = `t=${NOW},v1=${"0".repeat(64)},v1=${good}`;

    expect(verifyStripeWebhook({ rawBody: BODY, header, secret: SECRET, now: NOW })).toBe(true);
  });

  it("refuses when no configuration exists, rather than accepting everything", () => {
    expect(
      verifyStripeWebhook({ rawBody: BODY, header: sign(BODY), secret: "", now: NOW }),
    ).toBe(false);
  });

  it.each([
    ["empty", ""],
    ["no timestamp", "v1=abc"],
    ["no signature", `t=${NOW}`],
    ["not a signature header at all", "Bearer token"],
    ["a non-integer timestamp", `t=1614556800.5,v1=abc`],
  ])("refuses a header that is %s", (_label, header) => {
    expect(verifyStripeWebhook({ rawBody: BODY, header, secret: SECRET, now: NOW })).toBe(false);
  });

  /**
   * `v0` is the test-mode scheme.
   *
   * Accepting it would let a key from the Stripe dashboard's test mode sign an
   * event that credits a live subscription.
   */
  it("ignores a v0 signature, so a test-mode key cannot sign a live event", () => {
    const v0 = createHmac("sha256", SECRET).update(`${NOW}.${BODY}`).digest("hex");

    expect(
      verifyStripeWebhook({
        rawBody: BODY,
        header: `t=${NOW},v0=${v0}`,
        secret: SECRET,
        now: NOW,
      }),
    ).toBe(false);
  });
});

describe("parseStripeSignature", () => {
  it("reads the timestamp and every candidate signature", () => {
    expect(parseStripeSignature(`t=${NOW},v1=aaa,v1=bbb`)).toEqual({
      timestamp: NOW,
      signatures: ["aaa", "bbb"],
    });
  });

  it("tolerates the whitespace a proxy may introduce", () => {
    expect(parseStripeSignature(`t=${NOW}, v1=aaa`)?.signatures).toEqual(["aaa"]);
  });
});
