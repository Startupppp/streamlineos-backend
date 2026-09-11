import {
  isDue,
  readRunState,
  writeRunState,
} from "../workflow-execution-context";

const NOW = new Date("2026-08-23T10:00:00.000Z");

describe("workflow run state", () => {
  it("reads a fresh execution as starting from the top", () => {
    expect(readRunState(null)).toEqual({
      cursor: null,
      resumeAt: null,
      variables: {},
      steps: 0,
      infraAttempt: 0,
      dlqReason: null,
    });
  });

  it("round-trips through the jsonb column", () => {
    const state = {
      cursor: "node-2",
      resumeAt: NOW,
      variables: { score: 3 },
      steps: 4,
      infraAttempt: 2,
      dlqReason: null,
    };
    expect(readRunState(writeRunState(state))).toEqual(state);
  });

  it("round-trips a dlqReason when dead-lettered", () => {
    const state = {
      cursor: null,
      resumeAt: null,
      variables: {},
      steps: 7,
      infraAttempt: 8,
      dlqReason: "connection reset by peer",
    };
    expect(readRunState(writeRunState(state))).toEqual(state);
  });

  it("falls back to a clean state rather than throwing on corrupt context", () => {
    expect(readRunState({ cursor: 42, steps: "many" })).toEqual({
      cursor: null,
      resumeAt: null,
      variables: {},
      steps: 0,
      infraAttempt: 0,
      dlqReason: null,
    });
  });

  it("ignores an unparseable resumeAt instead of producing an Invalid Date", () => {
    expect(readRunState({ resumeAt: "not-a-date" }).resumeAt).toBeNull();
  });

  it("is due only once the instant has passed", () => {
    const state = readRunState({ resumeAt: NOW.toISOString() });
    expect(isDue(state, new Date(NOW.getTime() - 1))).toBe(false);
    expect(isDue(state, NOW)).toBe(true);
    expect(isDue(state, new Date(NOW.getTime() + 1))).toBe(true);
  });

  it("is never due without a resumeAt, so a pending row is not mistaken for a waiting one", () => {
    expect(isDue(readRunState({}), NOW)).toBe(false);
  });
});
