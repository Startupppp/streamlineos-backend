import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { HrBenefitsEnrollmentService } from "./hr-benefits-enrollment.service";

describe("HrBenefitsEnrollmentService.enroll — enrollment window is actually enforced", () => {
  function buildDb() {
    return {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([{ id: 1, orgId: "org-1", status: "active" }]),
          }),
        }),
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: 1, planId: 1, userId: "user-1", status: "active" }]),
        }),
      }),
    };
  }

  it("blocks enrollment when the plan's window is configured but not open", async () => {
    const plans = { checkEnrollmentWindowOpen: jest.fn().mockResolvedValue(false) };
    const service = new HrBenefitsEnrollmentService(buildDb() as never, undefined as never, plans as never);

    await expect(
      service.enroll("org-1", "user-1", 7, { planId: 1, dependentsCovered: 0 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(plans.checkEnrollmentWindowOpen).toHaveBeenCalledWith("org-1", 1);
  });

  it("allows enrollment when no window is configured (window check returns true)", async () => {
    const plans = { checkEnrollmentWindowOpen: jest.fn().mockResolvedValue(true) };
    const service = new HrBenefitsEnrollmentService(buildDb() as never, undefined as never, plans as never);

    const result = await service.enroll("org-1", "user-1", 7, { planId: 1, dependentsCovered: 0 });
    expect(result).toBeDefined();
  });

  it("rejects an account-only principal before it can use a legacy user id", async () => {
    const plans = { checkEnrollmentWindowOpen: jest.fn() };
    const db = buildDb();
    const service = new HrBenefitsEnrollmentService(db as never, undefined as never, plans as never);

    await expect(
      service.enroll("org-1", "user-1", null, { planId: 1, dependentsCovered: 0 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.select).not.toHaveBeenCalled();
  });
});
