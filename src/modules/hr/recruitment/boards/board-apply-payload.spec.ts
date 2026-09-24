import { createHmac } from "node:crypto";
import { normaliseBoardApply, verifyBoardSignature } from "./board-apply-payload";

const SECRET = "inbound-secret-for-this-org-and-board";

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifyBoardSignature", () => {
  const body = JSON.stringify({ applicationId: "A-1" });

  it("accepts a body signed with the organisation's secret", () => {
    expect(verifyBoardSignature(body, SECRET, sign(body))).toBe(true);
  });

  it("accepts the sha256= prefix boards commonly send", () => {
    expect(verifyBoardSignature(body, SECRET, `sha256=${sign(body)}`)).toBe(true);
  });

  it("refuses a body signed with a different secret", () => {
    expect(verifyBoardSignature(body, SECRET, sign(body, "someone-elses-secret"))).toBe(false);
  });

  /**
   * The bytes are what is signed, not the parsed object. A body that
   * round-trips through `JSON.parse`/`JSON.stringify` can come out with
   * different whitespace or key order and still be the same object — signing
   * the re-serialisation would accept a body the board never sent.
   */
  it("refuses a body that was re-serialised after signing", () => {
    const signature = sign(body);
    const reserialised = JSON.stringify(JSON.parse(body), null, 2);
    expect(verifyBoardSignature(reserialised, SECRET, signature)).toBe(false);
  });

  it("refuses a missing signature rather than treating absence as a pass", () => {
    expect(verifyBoardSignature(body, SECRET, undefined)).toBe(false);
    expect(verifyBoardSignature(body, SECRET, "")).toBe(false);
  });

  /**
   * `timingSafeEqual` throws on a length mismatch, and a throw here would be a
   * 500 where a 401 belongs — which is both a worse answer and a signal that
   * the length was wrong.
   */
  it("refuses a malformed signature without throwing", () => {
    expect(verifyBoardSignature(body, SECRET, "not-hex")).toBe(false);
    expect(verifyBoardSignature(body, SECRET, "ab")).toBe(false);
  });
});

describe("normaliseBoardApply", () => {
  it("reads the canonical shape", () => {
    expect(
      normaliseBoardApply({
        applicationId: "A-1",
        jobReference: "77",
        candidate: { name: "Asha Rao", email: "Asha@Example.com" },
        consent: true,
      }),
    ).toMatchObject({
      applicationId: "A-1",
      jobReference: "77",
      candidate: { name: "Asha Rao", email: "asha@example.com" },
      consent: true,
    });
  });

  it("reads a flat body with each vendor's own field names", () => {
    expect(
      normaliseBoardApply({
        applyId: "NAU-9",
        referenceId: 77,
        candidateName: "Asha Rao",
        candidateEmail: "asha@example.com",
        mobile: "+919876543210",
        cvUrl: "https://cdn.test/cv.pdf",
      }),
    ).toMatchObject({
      applicationId: "NAU-9",
      jobReference: 77,
      candidate: {
        name: "Asha Rao",
        phone: "+919876543210",
        resumeUrl: "https://cdn.test/cv.pdf",
      },
    });
  });

  it("reads a nested applicant object", () => {
    expect(
      normaliseBoardApply({
        id: "IND-3",
        sourceId: "77",
        applicant: { fullName: "Asha Rao", emailAddress: "asha@example.com" },
      }),
    ).toMatchObject({ applicationId: "IND-3", candidate: { name: "Asha Rao" } });
  });

  /**
   * The DPDP rule, in the mapper. Absent consent stays absent — it must not
   * become `false` that later reads as "we asked and they said no", nor `true`
   * because the payload was otherwise fine.
   */
  it("leaves consent undefined when the board did not send one", () => {
    const parsed = normaliseBoardApply({
      applicationId: "A-1",
      jobReference: "77",
      candidate: { name: "Asha Rao", email: "asha@example.com" },
    });
    expect(parsed.consent).toBeUndefined();
  });

  it("reads a stringified consent flag as consent", () => {
    const parsed = normaliseBoardApply({
      applicationId: "A-1",
      jobReference: "77",
      name: "Asha Rao",
      email: "asha@example.com",
      consentGiven: "true",
    });
    expect(parsed.consent).toBe(true);
  });

  /**
   * Boards add fields without telling anyone. Refusing the whole application
   * because Naukri started sending `campaignId` would lose a real candidate
   * over a field nobody reads.
   */
  it("ignores fields it does not know about", () => {
    expect(() =>
      normaliseBoardApply({
        applicationId: "A-1",
        jobReference: "77",
        candidate: { name: "Asha Rao", email: "asha@example.com" },
        campaignId: "spring-2026",
        vendorNoise: { deeply: { nested: true } },
      }),
    ).not.toThrow();
  });

  it("refuses a payload with no application id to be idempotent on", () => {
    expect(() =>
      normaliseBoardApply({ jobReference: "77", name: "Asha", email: "a@b.com" }),
    ).toThrow();
  });

  it("refuses an unusable email rather than creating a candidate nobody can reach", () => {
    expect(() =>
      normaliseBoardApply({ applicationId: "A-1", jobReference: "77", name: "Asha", email: "nope" }),
    ).toThrow();
  });

  it("caps a cover letter instead of accepting an unbounded body", () => {
    expect(() =>
      normaliseBoardApply({
        applicationId: "A-1",
        jobReference: "77",
        name: "Asha",
        email: "a@b.com",
        coverLetter: "x".repeat(5001),
      }),
    ).toThrow();
  });
});
