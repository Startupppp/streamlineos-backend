import {
  decideStop,
  ENROLLMENT_STATUSES,
  isConversion,
  TERMINAL_STATUSES,
  type EnrollmentFacts,
} from "./nurture-stop-conditions";

const RUNNING: EnrollmentFacts = {
  suppressed: false,
  hasConsent: true,
  appliedAfterEnrolmentAt: null,
  repliedAfterEnrolmentAt: null,
  candidateStatus: "SCREENING",
};

const LATER = new Date("2026-02-01T00:00:00.000Z");

describe("decideStop", () => {
  it("keeps a consented, quiet, open candidate in the campaign", () => {
    expect(decideStop(RUNNING)).toEqual({ stop: false });
  });

  it("stops on suppression", () => {
    const decision = decideStop({ ...RUNNING, suppressed: true });
    expect(decision).toMatchObject({ stop: true, status: "STOPPED_SUPPRESSED" });
  });

  it("stops without consent", () => {
    const decision = decideStop({ ...RUNNING, hasConsent: false });
    expect(decision).toMatchObject({ stop: true, status: "HELD_NO_CONSENT" });
  });

  it("stops when they applied", () => {
    const decision = decideStop({ ...RUNNING, appliedAfterEnrolmentAt: LATER });
    expect(decision).toMatchObject({ stop: true, status: "STOPPED_APPLIED" });
  });

  it("stops when they replied", () => {
    const decision = decideStop({ ...RUNNING, repliedAfterEnrolmentAt: LATER });
    expect(decision).toMatchObject({ stop: true, status: "STOPPED_REPLIED" });
  });

  it.each(["HIRED", "REJECTED"])("stops when the candidate is %s", (candidateStatus) => {
    const decision = decideStop({ ...RUNNING, candidateStatus });
    expect(decision).toMatchObject({ stop: true, status: "STOPPED_CLOSED" });
  });

  it("keeps running for a candidate mid-pipeline", () => {
    expect(decideStop({ ...RUNNING, candidateStatus: "INTERVIEW" })).toEqual({ stop: false });
  });

  /*
    The precedence cases. Each of these is true at the same time as the one
    below it for real people, and the recorded reason is what a recruiter reads
    months later — so the order is asserted rather than left to whichever branch
    happens to come first in the file.
  */
  it("reports suppression over a missing consent", () => {
    const decision = decideStop({ ...RUNNING, suppressed: true, hasConsent: false });
    expect(decision).toMatchObject({ status: "STOPPED_SUPPRESSED" });
  });

  it("reports a missing consent over an application", () => {
    const decision = decideStop({
      ...RUNNING,
      hasConsent: false,
      appliedAfterEnrolmentAt: LATER,
    });
    expect(decision).toMatchObject({ status: "HELD_NO_CONSENT" });
  });

  it("reports the application over the reply that came with it", () => {
    const decision = decideStop({
      ...RUNNING,
      appliedAfterEnrolmentAt: LATER,
      repliedAfterEnrolmentAt: LATER,
    });
    expect(decision).toMatchObject({ status: "STOPPED_APPLIED" });
  });

  it("reports a reply over the candidate having been closed", () => {
    const decision = decideStop({
      ...RUNNING,
      repliedAfterEnrolmentAt: LATER,
      candidateStatus: "REJECTED",
    });
    expect(decision).toMatchObject({ status: "STOPPED_REPLIED" });
  });

  it("gives every stop a reason a person can read", () => {
    const stopping: EnrollmentFacts[] = [
      { ...RUNNING, suppressed: true },
      { ...RUNNING, hasConsent: false },
      { ...RUNNING, appliedAfterEnrolmentAt: LATER },
      { ...RUNNING, repliedAfterEnrolmentAt: LATER },
      { ...RUNNING, candidateStatus: "HIRED" },
    ];
    for (const facts of stopping) {
      const decision = decideStop(facts);
      if (!decision.stop) throw new Error("expected a stop");
      expect(decision.reason.length).toBeGreaterThan(10);
      expect(decision.reason.endsWith(".")).toBe(true);
    }
  });

  it("never returns ACTIVE or COMPLETED as a stop reason", () => {
    const decision = decideStop({ ...RUNNING, suppressed: true });
    if (!decision.stop) throw new Error("expected a stop");
    expect(["ACTIVE", "COMPLETED"]).not.toContain(decision.status);
  });
});

describe("the status vocabulary", () => {
  /**
   * The drift this guards is the one that already happened once: a value added
   * on the backend while the frontend contract still narrowed to a shorter
   * list, which throws on parse and takes the whole screen down.
   */
  it("carries every value a stop can produce", () => {
    const produced = new Set(
      [
        { ...RUNNING, suppressed: true },
        { ...RUNNING, hasConsent: false },
        { ...RUNNING, appliedAfterEnrolmentAt: LATER },
        { ...RUNNING, repliedAfterEnrolmentAt: LATER },
        { ...RUNNING, candidateStatus: "HIRED" },
      ]
        .map(decideStop)
        .flatMap((decision) => (decision.stop ? [decision.status] : [])),
    );
    for (const status of produced) expect(ENROLLMENT_STATUSES).toContain(status);
  });

  it("treats everything except ACTIVE as terminal", () => {
    expect(TERMINAL_STATUSES).not.toContain("ACTIVE");
    expect(TERMINAL_STATUSES).toHaveLength(ENROLLMENT_STATUSES.length - 1);
  });
});

describe("isConversion", () => {
  it("counts an application and nothing else", () => {
    expect(isConversion("STOPPED_APPLIED")).toBe(true);
    for (const status of ENROLLMENT_STATUSES) {
      if (status === "STOPPED_APPLIED") continue;
      expect(isConversion(status)).toBe(false);
    }
  });
});
