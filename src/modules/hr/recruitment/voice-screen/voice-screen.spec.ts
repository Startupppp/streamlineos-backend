import {
  canComplete,
  parseVoiceScreenResult,
  resolveVoiceScreen,
  VOICE_SCREEN_ADAPTERS,
} from "./voice-screen";

const ANSWER = { question: "Notice period?", answer: "30 days", confidence: 0.9 };

describe("parseVoiceScreenResult", () => {
  it("accepts a well-formed result", () => {
    const parsed = parseVoiceScreenResult({
      reference: "CALL-1",
      answers: [ANSWER],
      rating: 4,
    });
    expect(parsed).toEqual({
      reference: "CALL-1",
      answers: [ANSWER],
      rating: 4,
    });
  });

  it("accepts a result with no rating", () => {
    expect(parseVoiceScreenResult({ reference: "CALL-1", answers: [] })?.rating).toBeNull();
  });

  it("treats a missing confidence as unknown rather than zero", () => {
    const parsed = parseVoiceScreenResult({
      reference: "CALL-1",
      answers: [{ question: "q", answer: "a" }],
    });
    expect(parsed?.answers[0]?.confidence).toBeNull();
  });

  it("refuses a payload that is not an object", () => {
    expect(parseVoiceScreenResult(null)).toBeNull();
    expect(parseVoiceScreenResult("CALL-1")).toBeNull();
    expect(parseVoiceScreenResult([])).toBeNull();
  });

  it("refuses a missing or oversized reference", () => {
    expect(parseVoiceScreenResult({ answers: [] })).toBeNull();
    expect(parseVoiceScreenResult({ reference: "", answers: [] })).toBeNull();
    expect(parseVoiceScreenResult({ reference: "x".repeat(201), answers: [] })).toBeNull();
  });

  /**
   * This arrives from outside with a valid signature. An unbounded array of
   * unbounded strings is a storage attack that authenticates.
   */
  it("caps the number of answers", () => {
    const answers = Array.from({ length: 31 }, () => ANSWER);
    expect(parseVoiceScreenResult({ reference: "CALL-1", answers })).toBeNull();
  });

  it("caps the length of a single answer", () => {
    const answers = [{ question: "q", answer: "x".repeat(5001) }];
    expect(parseVoiceScreenResult({ reference: "CALL-1", answers })).toBeNull();
  });

  it("refuses a rating outside the 1-5 scale the rest of recruitment uses", () => {
    for (const rating of [0, 6, 2.5, -1]) {
      expect(parseVoiceScreenResult({ reference: "CALL-1", answers: [], rating })).toBeNull();
    }
  });

  it("refuses a confidence outside 0-1", () => {
    const answers = [{ question: "q", answer: "a", confidence: 1.5 }];
    expect(parseVoiceScreenResult({ reference: "CALL-1", answers })).toBeNull();
  });

  it("refuses answers that are not objects", () => {
    expect(parseVoiceScreenResult({ reference: "CALL-1", answers: ["yes"] })).toBeNull();
  });
});

describe("canComplete", () => {
  /**
   * The acceptance criterion, in one function: nothing marks a screen
   * "completed by AI" on the strength of having asked for one.
   */
  it("refuses a provider completion with no answers", () => {
    expect(canComplete("PROVIDER", false)).toBe(false);
  });

  it("accepts a provider completion that carries answers", () => {
    expect(canComplete("PROVIDER", true)).toBe(true);
  });

  /**
   * A recruiter who ran the screen themselves needs no vendor result — they
   * were on the call. The row records RECRUITER, so the two are never confused.
   */
  it("accepts a recruiter completion either way", () => {
    expect(canComplete("RECRUITER", false)).toBe(true);
    expect(canComplete("RECRUITER", true)).toBe(true);
  });
});

describe("the voice screen provider", () => {
  /**
   * The only adapter in this lane that would place a phone call. A stub would
   * either ring a real candidate or — the failure nobody would catch — record a
   * screen as scored with no one having spoken to anyone.
   */
  it("ships no adapter", () => {
    expect(VOICE_SCREEN_ADAPTERS.size).toBe(0);
  });

  it("blocks with no-integration when nothing is connected", () => {
    expect(resolveVoiceScreen(null)).toMatchObject({
      status: "BLOCKED",
      code: "no-integration",
    });
  });

  it("blocks as not-implemented with credentials saved, and names the fallback", () => {
    const resolved = resolveVoiceScreen({
      platform: "VOICE_SCREEN",
      isActive: true,
      token: "vendor-key",
      meta: {},
    });
    expect(resolved).toMatchObject({ status: "BLOCKED", code: "not-implemented" });
    if ("adapter" in resolved) throw new Error("expected no adapter");
    expect(resolved.message).toContain("record it as a phone interview");
  });
});
