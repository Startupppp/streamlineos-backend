import { signPayload } from "./mailbox-push";
import { readWebFormSubmission, webFormSubmissionSchema } from "./web-form-submission";
import { CONTACT_ENQUIRY } from "./web-form-fixtures";

/**
 * The boundary, which is the only thing standing between a public URL and the
 * CRM.
 *
 * Everything here is about what a submission is not allowed to do: reach the
 * normaliser unsigned, name its own tenant, or be big enough to matter. The
 * normaliser's own rules are tested next door, against the same fixtures.
 */

const SECRET = "a-form-signing-secret";

const post = (payload: unknown, over: { secret?: string; signature?: string } = {}) => {
  const rawBody = JSON.stringify(payload);
  const signature = over.signature ?? signPayload(over.secret ?? SECRET, rawBody);
  return readWebFormSubmission(rawBody, signature, SECRET, JSON.parse(rawBody));
};

describe("readWebFormSubmission", () => {
  it("accepts a submission signed with the form's secret", () => {
    const verdict = post(CONTACT_ENQUIRY);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.submission.fields).toHaveLength(8);
  });

  it("refuses one signed with a different secret", () => {
    expect(post(CONTACT_ENQUIRY, { secret: "somebody-elses-secret" })).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("refuses one with no signature at all", () => {
    const rawBody = JSON.stringify(CONTACT_ENQUIRY);
    expect(readWebFormSubmission(rawBody, undefined, SECRET, JSON.parse(rawBody))).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  /**
   * The bug `mailbox-push` already paid for, on a second unauthenticated door.
   *
   * A header of 64 multibyte characters passes a character-length check and then
   * throws `RangeError` out of `timingSafeEqual` — a 500 and a stack trace where
   * a silent rejection belongs, and trivially reachable because the header is
   * whatever the caller sends. This endpoint reuses that file's comparison
   * rather than growing its own, and this test is what says so.
   */
  it("rejects a multibyte signature rather than throwing out of the endpoint", () => {
    const multibyte = "é".repeat(64);
    expect(() => post(CONTACT_ENQUIRY, { signature: multibyte })).not.toThrow();
    expect(post(CONTACT_ENQUIRY, { signature: multibyte })).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  /**
   * The signature is checked before the body is read, so a malformed payload
   * from a stranger says nothing about why. Only a caller holding the secret
   * gets the detail, which is the point of returning any.
   */
  it("says nothing about a malformed body it could not authenticate", () => {
    const rawBody = JSON.stringify({ nonsense: true });
    const verdict = readWebFormSubmission(rawBody, "not-a-signature", SECRET, JSON.parse(rawBody));
    expect(verdict).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("tells an authenticated caller which field was wrong", () => {
    const verdict = post({ fields: [] });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("malformed");
      expect(verdict.issues?.join(" ")).toContain("fields");
    }
  });

  /**
   * A submission may not name its organisation.
   *
   * The tenant comes from the form's registration, and `.strict()` is what makes
   * that a fact rather than a convention: rejected outright, because "ignored"
   * is one careless destructure away from "used".
   */
  it("rejects a body that tries to name a tenant", () => {
    const verdict = post({ ...CONTACT_ENQUIRY, organizationId: "org-somebody-else" });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("malformed");
  });

  it("rejects a submission with more fields than a form has boxes", () => {
    const fields = Array.from({ length: 101 }, (_, index) => ({
      name: `q${index}`,
      value: "x",
    }));
    const verdict = post({ ...CONTACT_ENQUIRY, fields });
    expect(verdict.ok).toBe(false);
  });

  it("rejects a field value long enough to be a payload rather than an answer", () => {
    const verdict = post({
      ...CONTACT_ENQUIRY,
      fields: [{ name: "Message", value: "x".repeat(5_001) }],
    });
    expect(verdict.ok).toBe(false);
  });

  it("accepts the value shapes a real form produces", () => {
    const parsed = webFormSubmissionSchema.safeParse({
      fields: [
        { name: "text", value: "a string" },
        { name: "number", value: 250 },
        { name: "checkbox", value: true },
        { name: "skipped", value: null },
        { name: "multi-select", value: ["CRM", "Support"] },
      ],
    });
    expect(parsed.success).toBe(true);
  });
});
