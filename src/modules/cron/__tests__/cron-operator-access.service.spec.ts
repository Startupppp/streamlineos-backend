import { CronOperatorAccessService } from "../cron-operator-access.service";

describe("CronOperatorAccessService", () => {
  it("delegates pending-grant expiry to the operator-access sweep", async () => {
    const operatorAccess = { expirePendingGrants: jest.fn().mockResolvedValue(3) };
    const service = new CronOperatorAccessService(operatorAccess as never);

    await expect(service.expirePendingGrants()).resolves.toEqual({ expired: 3 });
    expect(operatorAccess.expirePendingGrants).toHaveBeenCalledTimes(1);
  });
});
