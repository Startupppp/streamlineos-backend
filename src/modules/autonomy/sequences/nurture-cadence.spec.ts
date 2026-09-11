import {
  MIN_STEP_WAIT_HOURS,
  MAX_STEP_WAIT_HOURS,
  MAX_SEQUENCE_STEPS,
  NURTURE_EXIT_REASONS,
  repliedSinceEnrolment,
  resolveCadence,
  clampWaitHours,
  waitMsForStep,
  stepNumbersAreDense,
  type EnrolmentSnapshot,
  type CadenceStep,
} from "./nurture-cadence";

describe("nurture-cadence", () => {
  describe("constants derived from frequency caps", () => {
    it("sets MIN_STEP_WAIT_HOURS to the sparsest cap window", () => {
      // Derived from PARTY_FREQUENCY_CAPS: 5 days / 1 send and 30 days / 3 sends
      // The binding constraint is 30/3 = 10 days = 240 hours
      expect(MIN_STEP_WAIT_HOURS).toBeGreaterThanOrEqual(240);
    });

    it("caps MAX_STEP_WAIT_HOURS at 90 days", () => {
      expect(MAX_STEP_WAIT_HOURS).toBe(90 * 24);
    });

    it("limits sequences to 12 steps max", () => {
      expect(MAX_SEQUENCE_STEPS).toBe(12);
    });
  });

  describe("repliedSinceEnrolment", () => {
    const enrolledAt = new Date("2026-08-01T10:00:00Z");

    it("returns false when lastInboundAt is null", () => {
      expect(repliedSinceEnrolment({ enrolledAt, lastInboundAt: null })).toBe(false);
    });

    it("returns false when lastInboundAt is before enrolment", () => {
      const lastInboundAt = new Date("2026-07-30T10:00:00Z");
      expect(repliedSinceEnrolment({ enrolledAt, lastInboundAt })).toBe(false);
    });

    it("returns false when lastInboundAt equals enrolledAt", () => {
      expect(repliedSinceEnrolment({ enrolledAt, lastInboundAt: enrolledAt })).toBe(false);
    });

    it("returns true when lastInboundAt is strictly after enrolment", () => {
      const lastInboundAt = new Date("2026-08-02T14:00:00Z");
      expect(repliedSinceEnrolment({ enrolledAt, lastInboundAt })).toBe(true);
    });
  });

  describe("resolveCadence", () => {
    const baseSnapshot: EnrolmentSnapshot = {
      enrolmentStatus: "active",
      sequenceStatus: "active",
      sequenceDeleted: false,
      currentStep: 0,
      enrolledAt: new Date("2026-08-01T10:00:00Z"),
      lastInboundAt: null,
      totalSteps: 3,
    };

    it("exits with 'replied' when customer replied after enrolment", () => {
      const snapshot: EnrolmentSnapshot = {
        ...baseSnapshot,
        lastInboundAt: new Date("2026-08-02T10:00:00Z"),
      };
      const result = resolveCadence(snapshot);
      expect(result).toEqual({ action: "exit", reason: "replied" });
    });

    it("reply outranks all other exit reasons", () => {
      const snapshot: EnrolmentSnapshot = {
        ...baseSnapshot,
        sequenceDeleted: true,
        sequenceStatus: "paused",
        lastInboundAt: new Date("2026-08-02T10:00:00Z"),
      };
      const result = resolveCadence(snapshot);
      expect(result).toEqual({ action: "exit", reason: "replied" });
    });

    it("stops without exit when enrolment is already inactive", () => {
      const snapshot: EnrolmentSnapshot = {
        ...baseSnapshot,
        enrolmentStatus: "exited",
      };
      const result = resolveCadence(snapshot);
      expect(result.action).toBe("stop");
      if (result.action === "stop") {
        expect(result.reason).toBe("enrolment-exited");
      }
    });

    it("exits with 'sequence-deleted' when sequence is deleted", () => {
      const snapshot: EnrolmentSnapshot = {
        ...baseSnapshot,
        sequenceDeleted: true,
      };
      const result = resolveCadence(snapshot);
      expect(result).toEqual({ action: "exit", reason: "sequence-deleted" });
    });

    it("exits with 'sequence-paused' when sequence is paused", () => {
      const snapshot: EnrolmentSnapshot = {
        ...baseSnapshot,
        sequenceStatus: "paused",
      };
      const result = resolveCadence(snapshot);
      expect(result).toEqual({ action: "exit", reason: "sequence-paused" });
    });

    it("exits with 'no-steps' when sequence has no steps", () => {
      const snapshot: EnrolmentSnapshot = {
        ...baseSnapshot,
        totalSteps: 0,
      };
      const result = resolveCadence(snapshot);
      expect(result).toEqual({ action: "exit", reason: "no-steps" });
    });

    it("completes when currentStep equals totalSteps", () => {
      const snapshot: EnrolmentSnapshot = {
        ...baseSnapshot,
        currentStep: 3,
        totalSteps: 3,
      };
      const result = resolveCadence(snapshot);
      expect(result).toEqual({ action: "complete" });
    });

    it("sends next step when enrolment is active and has remaining steps", () => {
      const snapshot: EnrolmentSnapshot = {
        ...baseSnapshot,
        currentStep: 1,
        totalSteps: 3,
      };
      const result = resolveCadence(snapshot);
      expect(result).toEqual({ action: "send", stepNumber: 2 });
    });

    it("sends step 1 when currentStep is 0", () => {
      const snapshot: EnrolmentSnapshot = {
        ...baseSnapshot,
        currentStep: 0,
        totalSteps: 3,
      };
      const result = resolveCadence(snapshot);
      expect(result).toEqual({ action: "send", stepNumber: 1 });
    });
  });

  describe("clampWaitHours", () => {
    it("clamps to MIN_STEP_WAIT_HOURS when below floor", () => {
      expect(clampWaitHours(1)).toBe(MIN_STEP_WAIT_HOURS);
      expect(clampWaitHours(0)).toBe(MIN_STEP_WAIT_HOURS);
      expect(clampWaitHours(-100)).toBe(MIN_STEP_WAIT_HOURS);
    });

    it("clamps to MAX_STEP_WAIT_HOURS when above ceiling", () => {
      expect(clampWaitHours(10000)).toBe(MAX_STEP_WAIT_HOURS);
      expect(clampWaitHours(Infinity)).toBe(MIN_STEP_WAIT_HOURS);
    });

    it("returns floor for NaN and non-finite values", () => {
      expect(clampWaitHours(NaN)).toBe(MIN_STEP_WAIT_HOURS);
      expect(clampWaitHours(Infinity)).toBe(MIN_STEP_WAIT_HOURS);
      expect(clampWaitHours(-Infinity)).toBe(MIN_STEP_WAIT_HOURS);
    });

    it("preserves values within range, floored to integer", () => {
      expect(clampWaitHours(300)).toBe(300);
      expect(clampWaitHours(300.7)).toBe(300);
    });
  });

  describe("waitMsForStep", () => {
    const steps: CadenceStep[] = [
      { stepNumber: 1, waitHours: MIN_STEP_WAIT_HOURS },
      { stepNumber: 2, waitHours: 300 },
      { stepNumber: 3, waitHours: 500 },
    ];

    it("returns wait in milliseconds for the matching step", () => {
      const wait1 = waitMsForStep(steps, 1);
      const wait2 = waitMsForStep(steps, 2);
      const wait3 = waitMsForStep(steps, 3);

      expect(wait1).toBe(MIN_STEP_WAIT_HOURS * 3_600_000);
      expect(wait2).toBe(300 * 3_600_000);
      expect(wait3).toBe(500 * 3_600_000);
    });

    it("clamps values below MIN_STEP_WAIT_HOURS", () => {
      const shortSteps: CadenceStep[] = [
        { stepNumber: 1, waitHours: 24 },
      ];
      const wait = waitMsForStep(shortSteps, 1);
      expect(wait).toBe(MIN_STEP_WAIT_HOURS * 3_600_000);
    });

    it("returns 0 when step number is not found", () => {
      expect(waitMsForStep(steps, 99)).toBe(0);
      expect(waitMsForStep([], 1)).toBe(0);
    });
  });

  describe("stepNumbersAreDense", () => {
    it("accepts a sequence numbered 1, 2, 3", () => {
      const steps: CadenceStep[] = [
        { stepNumber: 1, waitHours: 24 },
        { stepNumber: 2, waitHours: 48 },
        { stepNumber: 3, waitHours: 72 },
      ];
      expect(stepNumbersAreDense(steps)).toBe(true);
    });

    it("accepts out-of-order steps as long as they are dense", () => {
      const steps: CadenceStep[] = [
        { stepNumber: 3, waitHours: 72 },
        { stepNumber: 1, waitHours: 24 },
        { stepNumber: 2, waitHours: 48 },
      ];
      expect(stepNumbersAreDense(steps)).toBe(true);
    });

    it("rejects a gap in numbering (1, 2, 4)", () => {
      const steps: CadenceStep[] = [
        { stepNumber: 1, waitHours: 24 },
        { stepNumber: 2, waitHours: 48 },
        { stepNumber: 4, waitHours: 96 },
      ];
      expect(stepNumbersAreDense(steps)).toBe(false);
    });

    it("rejects numbering not starting at 1", () => {
      const steps: CadenceStep[] = [
        { stepNumber: 0, waitHours: 24 },
        { stepNumber: 1, waitHours: 48 },
      ];
      expect(stepNumbersAreDense(steps)).toBe(false);
    });

    it("accepts empty sequence (vacuously true)", () => {
      expect(stepNumbersAreDense([])).toBe(true);
    });
  });
});
