import { HrBenefitsPlansService } from "./hr-benefits-plans.service";

describe("HrBenefitsPlansService.checkEnrollmentWindowOpen", () => {
  function buildDb(rows: Array<{ planId: number | null; status: string; opensAt: Date; closesAt: Date }>) {
    return {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(rows),
        }),
      }),
    };
  }

  it("allows enrollment when no window is configured for the plan at all", async () => {
    const service = new HrBenefitsPlansService(buildDb([]) as never);
    expect(await service.checkEnrollmentWindowOpen("org-1", 1)).toBe(true);
  });

  it("blocks enrollment when a window is configured but currently closed/upcoming", async () => {
    const future = new Date(Date.now() + 86_400_000);
    const db = buildDb([{ planId: 1, status: "upcoming", opensAt: future, closesAt: new Date(future.getTime() + 86_400_000) }]);
    const service = new HrBenefitsPlansService(db as never);
    expect(await service.checkEnrollmentWindowOpen("org-1", 1)).toBe(false);
  });

  it("allows enrollment when the configured window is open and within range", async () => {
    const now = new Date();
    const db = buildDb([
      { planId: 1, status: "open", opensAt: new Date(now.getTime() - 86_400_000), closesAt: new Date(now.getTime() + 86_400_000) },
    ]);
    const service = new HrBenefitsPlansService(db as never);
    expect(await service.checkEnrollmentWindowOpen("org-1", 1)).toBe(true);
  });

  it("honors an org-wide window (null planId) for a plan with no plan-specific window", async () => {
    const now = new Date();
    const db = buildDb([
      { planId: null, status: "closed", opensAt: new Date(now.getTime() - 172_800_000), closesAt: new Date(now.getTime() - 86_400_000) },
    ]);
    const service = new HrBenefitsPlansService(db as never);
    expect(await service.checkEnrollmentWindowOpen("org-1", 1)).toBe(false);
  });
});
