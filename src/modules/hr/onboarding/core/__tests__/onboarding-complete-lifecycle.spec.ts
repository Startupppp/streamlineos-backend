import { OnboardingProbationService } from "../onboarding-probation.service";

describe("OnboardingProbationService — complete lifecycle", () => {
  it("moves ONBOARDING → PROBATION when policy has durationDays", async () => {
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([
                {
                  id: 5,
                  personId: 3,
                  joiningDate: "2026-07-01",
                  lifecycleStatus: "ONBOARDING",
                },
              ]),
            }),
          }),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(undefined),
        }),
      }),
    };

    const policyEval = {
      evaluatePolicy: jest.fn().mockResolvedValue({
        rules: { durationDays: 90 },
      }),
    };
    const employments = {
      transition: jest.fn().mockResolvedValue({ lifecycleStatus: "PROBATION" }),
    };
    const probationReviews = {
      setupProbation: jest.fn().mockResolvedValue({}),
    };

    const service = new OnboardingProbationService(
      db as never,
      policyEval as never,
      employments as never,
      probationReviews as never,
    );

    const result = await service.setupProbationForUser("org-1", "user-1");

    expect(result.lifecycleStatus).toBe("PROBATION");
    expect(employments.transition).toHaveBeenCalledWith(
      "org-1",
      5,
      "user-1",
      expect.objectContaining({ toStatus: "PROBATION" }),
    );
    expect(probationReviews.setupProbation).toHaveBeenCalled();
  });

  it("moves ONBOARDING → ACTIVE when no probation policy", async () => {
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([
                {
                  id: 5,
                  personId: 3,
                  joiningDate: "2026-07-01",
                  lifecycleStatus: "ONBOARDING",
                },
              ]),
            }),
          }),
        }),
      }),
      update: jest.fn(),
    };

    const policyEval = { evaluatePolicy: jest.fn().mockResolvedValue(null) };
    const employments = {
      transition: jest.fn().mockResolvedValue({ lifecycleStatus: "ACTIVE" }),
    };
    const probationReviews = { setupProbation: jest.fn() };

    const service = new OnboardingProbationService(
      db as never,
      policyEval as never,
      employments as never,
      probationReviews as never,
    );

    const result = await service.setupProbationForUser("org-1", "user-1");

    expect(result.lifecycleStatus).toBe("ACTIVE");
    expect(employments.transition).toHaveBeenCalledWith(
      "org-1",
      5,
      "user-1",
      expect.objectContaining({ toStatus: "ACTIVE" }),
    );
    expect(probationReviews.setupProbation).not.toHaveBeenCalled();
  });
});
