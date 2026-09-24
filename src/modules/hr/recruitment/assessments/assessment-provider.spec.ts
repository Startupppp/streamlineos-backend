import {
  ASSESSMENT_ADAPTERS,
  normaliseScore,
  resolveAssessment,
  verdictFor,
} from "./assessment-provider";
import { verifyVendorSignature } from "../integrations/vendor-signature";
import { createHmac } from "node:crypto";

describe("normaliseScore", () => {
  it("turns a vendor's scale into a percentage", () => {
    expect(normaliseScore(42, 60)).toEqual({ score: 42, maxScore: 60, percent: 70 });
  });

  it("keeps one decimal place, so 1 of 3 is not 33", () => {
    expect(normaliseScore(1, 3)?.percent).toBe(33.3);
  });

  it("handles the ends of the range", () => {
    expect(normaliseScore(0, 10)?.percent).toBe(0);
    expect(normaliseScore(10, 10)?.percent).toBe(100);
  });

  /**
   * A score above its own maximum is a vendor bug or a forged payload, and
   * either way it must not become a 130% pass.
   */
  it("refuses a score outside the declared range", () => {
    expect(normaliseScore(13, 10)).toBeNull();
    expect(normaliseScore(-1, 10)).toBeNull();
  });

  it("refuses a zero or negative maximum rather than dividing by it", () => {
    expect(normaliseScore(5, 0)).toBeNull();
    expect(normaliseScore(5, -10)).toBeNull();
  });

  it("refuses values that are not finite numbers", () => {
    expect(normaliseScore(Number.NaN, 10)).toBeNull();
    expect(normaliseScore(5, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("verdictFor", () => {
  /**
   * The one that stops a fabricated verdict. With no pass mark set, the product
   * has no basis for PASSED or FAILED and says so by returning null; the caller
   * leaves the assessment PENDING with a score attached.
   */
  it("returns null when the organisation has set no pass mark", () => {
    expect(verdictFor(91, null)).toBeNull();
    expect(verdictFor(4, null)).toBeNull();
  });

  it("passes at and above the bar", () => {
    expect(verdictFor(70, 70)).toBe("PASSED");
    expect(verdictFor(70.1, 70)).toBe("PASSED");
  });

  it("fails below it", () => {
    expect(verdictFor(69.9, 70)).toBe("FAILED");
  });
});

describe("the assessment provider", () => {
  /**
   * A stub here would produce an invitation URL that goes nowhere — a candidate
   * told by an employer to sit a test that does not exist.
   */
  it("ships no adapter", () => {
    expect(ASSESSMENT_ADAPTERS.size).toBe(0);
  });

  it("blocks with no-integration when nothing is connected", () => {
    expect(resolveAssessment(null)).toMatchObject({
      status: "BLOCKED",
      code: "no-integration",
    });
  });

  it("blocks as not-implemented with credentials saved, and names the fallback", () => {
    const resolved = resolveAssessment({
      platform: "ASSESSMENT",
      isActive: true,
      token: "vendor-key",
      meta: {},
    });
    expect(resolved).toMatchObject({ status: "BLOCKED", code: "not-implemented" });
    if ("adapter" in resolved) throw new Error("expected no adapter");
    expect(resolved.message).toContain("vendor's own dashboard");
  });
});

describe("verifyVendorSignature", () => {
  const secret = "shhh";
  const body = JSON.stringify({ reference: "INV-1", score: 8, maxScore: 10 });
  const good = createHmac("sha256", secret).update(body).digest("hex");

  it("accepts a correct signature", () => {
    expect(verifyVendorSignature(body, secret, good)).toBe(true);
  });

  it("accepts the sha256= prefix vendors often send", () => {
    expect(verifyVendorSignature(body, secret, `sha256=${good}`)).toBe(true);
  });

  it("rejects a signature over different bytes", () => {
    const other = createHmac("sha256", secret).update(`${body} `).digest("hex");
    expect(verifyVendorSignature(body, secret, other)).toBe(false);
  });

  it("rejects the wrong secret", () => {
    expect(verifyVendorSignature(body, "wrong", good)).toBe(false);
  });

  it("rejects a missing signature rather than passing", () => {
    expect(verifyVendorSignature(body, secret, undefined)).toBe(false);
    expect(verifyVendorSignature(body, secret, "")).toBe(false);
  });

  /**
   * `timingSafeEqual` throws on mismatched lengths, and a throw on a public
   * endpoint would turn a malformed signature into a 500.
   */
  it("rejects a short signature without throwing", () => {
    expect(() => verifyVendorSignature(body, secret, "abcd")).not.toThrow();
    expect(verifyVendorSignature(body, secret, "abcd")).toBe(false);
  });

  it("rejects a non-hex signature without throwing", () => {
    expect(verifyVendorSignature(body, secret, "not-a-signature")).toBe(false);
  });

  it("verifies the exact bytes, not a re-serialised body", () => {
    const reSerialised = JSON.stringify(JSON.parse(body), null, 2);
    expect(verifyVendorSignature(reSerialised, secret, good)).toBe(false);
  });
});
