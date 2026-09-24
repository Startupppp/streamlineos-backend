import { RECRUITMENT_EVENTS } from "../recruitment-webhook-events";
import { HR_AUTOMATION_EVENTS } from "../../automations/hr-automation-events";
import {
  SANDBOX_EVENTS,
  fieldDocsFor,
  isRecruitmentEvent,
  isSandboxEvent,
  samplePayloadFor,
  sandboxBody,
  sandboxSignature,
  verifySandboxSignature,
} from "./sandbox-events";

describe("the sandbox event vocabulary", () => {
  /**
   * The union is the whole point. `hr_webhook_subscriptions` and
   * `hr_webhook_deliveries` are written by two services, and only one of their
   * vocabularies was ever consulted on the way back out — which is why a
   * subscription to `candidate.hired` tested as `employee.created`, a
   * recruitment delivery could not be redelivered, and the retry sweep skipped
   * every failed hiring delivery in the table.
   */
  it("covers both vocabularies", () => {
    for (const event of RECRUITMENT_EVENTS) expect(isSandboxEvent(event)).toBe(true);
    for (const event of HR_AUTOMATION_EVENTS) expect(isSandboxEvent(event)).toBe(true);
    expect(SANDBOX_EVENTS).toHaveLength(RECRUITMENT_EVENTS.length + HR_AUTOMATION_EVENTS.length);
  });

  it("refuses an event from neither", () => {
    expect(isSandboxEvent("candidate.teleported")).toBe(false);
    expect(isSandboxEvent("")).toBe(false);
  });

  it("separates the hiring events from the rest", () => {
    for (const event of RECRUITMENT_EVENTS) expect(isRecruitmentEvent(event)).toBe(true);
    expect(isRecruitmentEvent("employee.created")).toBe(false);
  });

  it("has a sample payload and field docs for every hiring event", () => {
    for (const event of RECRUITMENT_EVENTS) {
      expect(Object.keys(samplePayloadFor(event)).length).toBeGreaterThan(0);
      expect(fieldDocsFor(event).length).toBeGreaterThan(0);
    }
  });

  /**
   * The HR map declares a type per field and the recruitment map does not.
   * Defaulting the recruitment ones to `"string"` would publish a contract
   * saying `candidateId` is a string, which it is not — so the key is absent
   * rather than wrong.
   */
  it("does not invent a type for a field whose type it does not know", () => {
    for (const doc of fieldDocsFor("candidate.hired")) {
      expect(doc.type).toBeUndefined();
      expect(doc.field).toBeTruthy();
      expect(doc.label).toBeTruthy();
    }
    expect(fieldDocsFor("employee.created").some((d) => d.type !== undefined)).toBe(true);
  });
});

describe("the signature a receiver has to reproduce", () => {
  const SECRET = "whsec_test";
  const AT = new Date("2026-01-01T00:00:00.000Z");

  it("signs the exact bytes of the body", () => {
    const body = sandboxBody("candidate.hired", { candidateId: 1 }, AT);
    expect(body).toBe(
      '{"event":"candidate.hired","data":{"candidateId":1},"timestamp":"2026-01-01T00:00:00.000Z"}',
    );
    expect(verifySandboxSignature(SECRET, body, sandboxSignature(SECRET, body))).toBe(true);
  });

  it("is prefixed sha256= and is hex", () => {
    const body = sandboxBody("candidate.applied", {}, AT);
    expect(sandboxSignature(SECRET, body)).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("rejects a body that changed by one byte", () => {
    const body = sandboxBody("candidate.hired", { candidateId: 1 }, AT);
    const signature = sandboxSignature(SECRET, body);
    const tampered = sandboxBody("candidate.hired", { candidateId: 2 }, AT);
    expect(verifySandboxSignature(SECRET, tampered, signature)).toBe(false);
  });

  it("rejects the right body signed with the wrong secret", () => {
    const body = sandboxBody("candidate.hired", { candidateId: 1 }, AT);
    expect(
      verifySandboxSignature(SECRET, body, sandboxSignature("whsec_other", body)),
    ).toBe(false);
  });

  /**
   * `timingSafeEqual` throws on a length mismatch rather than returning false,
   * so a caller that skips the length check turns a malformed header into a
   * 500 — which is a denial of service reachable by anybody who can post a
   * header.
   */
  it("returns false for a malformed header instead of throwing", () => {
    const body = sandboxBody("candidate.hired", {}, AT);
    expect(verifySandboxSignature(SECRET, body, "")).toBe(false);
    expect(verifySandboxSignature(SECRET, body, "sha256=short")).toBe(false);
    expect(verifySandboxSignature(SECRET, body, "x".repeat(500))).toBe(false);
  });
});
