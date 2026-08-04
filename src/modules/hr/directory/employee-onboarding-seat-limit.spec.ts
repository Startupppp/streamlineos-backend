import { EmployeeOnboardingService } from "./employee-onboarding.service";

describe("EmployeeOnboardingService member-seat reservation", () => {
  it("locks the organization quota before checking the limit in the same transaction", async () => {
    const tx = { execute: jest.fn().mockResolvedValue([]) };
    const planLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
    const service = new EmployeeOnboardingService(
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      planLimits as never,
    );

    await (
      service as unknown as {
        reserveMemberSeat: (transaction: never, orgId: string) => Promise<void>;
      }
    ).reserveMemberSeat(tx as never, "org-1");

    expect(tx.execute).toHaveBeenCalledTimes(1);
    expect(planLimits.assertWithinLimit).toHaveBeenCalledWith(
      "org-1",
      "members",
      1,
      tx,
    );
    expect(tx.execute.mock.invocationCallOrder[0]).toBeLessThan(
      planLimits.assertWithinLimit.mock.invocationCallOrder[0] ?? 0,
    );
  });
});
