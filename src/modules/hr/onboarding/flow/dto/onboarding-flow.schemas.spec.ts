import {
  ONBOARDING_DRAFT_MAX_DEPTH,
  stripOnboardingDraftSecrets,
} from "../onboarding-session-privacy";
import { sessionPatchSchema } from "./onboarding-flow.schemas";

function nest(levels: number, leaf: Record<string, unknown>): Record<string, unknown> {
  let current: Record<string, unknown> = leaf;
  for (let i = 0; i < levels; i += 1) current = { child: current };
  return current;
}

function deepest(value: unknown): unknown {
  let current = value;
  while (
    typeof current === "object" &&
    current !== null &&
    !Array.isArray(current) &&
    "child" in current
  ) {
    current = (current as Record<string, unknown>).child;
  }
  return current;
}

describe("sessionPatchSchema draft depth boundary", () => {
  it("accepts a container sitting exactly on the sanitizer boundary", () => {
    const result = sessionPatchSchema.safeParse({
      data: nest(ONBOARDING_DRAFT_MAX_DEPTH, { keepMe: "visible" }),
    });
    expect(result.success).toBe(true);
  });

  it("rejects a container one level past the sanitizer boundary", () => {
    const result = sessionPatchSchema.safeParse({
      data: nest(ONBOARDING_DRAFT_MAX_DEPTH + 1, { accountNumber: "000000" }),
    });
    expect(result.success).toBe(false);
  });

  it("rejects over-depth nesting reached through an array", () => {
    const result = sessionPatchSchema.safeParse({
      data: { rows: [nest(ONBOARDING_DRAFT_MAX_DEPTH, { pan: "AAAAA0000A" })] },
    });
    expect(result.success).toBe(false);
  });

  it("never accepts a payload whose leaf the sanitizer would silently discard", () => {
    for (let levels = 0; levels <= ONBOARDING_DRAFT_MAX_DEPTH + 3; levels += 1) {
      const data = nest(levels, { keepMe: "visible" });
      const accepted = sessionPatchSchema.safeParse({ data }).success;
      if (!accepted) continue;
      expect(deepest(stripOnboardingDraftSecrets(data))).toEqual({ keepMe: "visible" });
    }
  });

  it("strips a secret from every payload the schema accepts", () => {
    for (let levels = 0; levels <= ONBOARDING_DRAFT_MAX_DEPTH; levels += 1) {
      const data = nest(levels, { accountNumber: "000000", bankName: "Test Bank" });
      expect(sessionPatchSchema.safeParse({ data }).success).toBe(true);
      expect(deepest(stripOnboardingDraftSecrets(data))).toEqual({ bankName: "Test Bank" });
    }
  });

  it("accepts an ordinary shallow draft", () => {
    const result = sessionPatchSchema.safeParse({
      currentStep: "bank-details",
      data: { bank: { country: "IN", accountHolderName: "Test Person" } },
      completedSteps: ["personal"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown top-level keys", () => {
    const result = sessionPatchSchema.safeParse({ data: {}, injected: true });
    expect(result.success).toBe(false);
  });
});
