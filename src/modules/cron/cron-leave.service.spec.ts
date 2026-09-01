import { CronLeaveService } from "./cron-leave.service";
import { CronLeaveResetService } from "./cron-leave-reset.service";

jest.mock("../../common/tenant", () => ({
  forEachOrg: jest.fn(),
}));

describe("CronLeaveService — expireUnusedMonthlyLeaves N+1 regression", () => {
  function buildSelectMock(responses: unknown[][]) {
    let call = 0;
    return jest.fn().mockImplementation(() => {
      const idx = call++;
      const data = responses[idx] ?? [];
      return {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue(data),
      };
    });
  }

  it("issues exactly one db.transaction for a page of N balances, not N transactions", async () => {
    const executeSpy = jest.fn().mockResolvedValue({ rows: [] });
    const insertValuesSpy = jest.fn().mockResolvedValue([]);
    const insertSpy = jest.fn().mockReturnValue({ values: insertValuesSpy });
    const transactionSpy = jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({ execute: executeSpy, insert: insertSpy }),
    );

    const db = {
      transaction: transactionSpy,
      select: buildSelectMock([
        [{ leaveTypeId: 10, accrualRate: "3", orgId: "o1" }],
        [
          { id: 1, orgId: "o1", userId: "u1", leaveTypeId: 10, balance: "10" },
          { id: 2, orgId: "o1", userId: "u2", leaveTypeId: 10, balance: "8" },
          { id: 3, orgId: "o1", userId: "u3", leaveTypeId: 10, balance: "6" },
        ],
        [],
      ]),
    };

    const service = new CronLeaveService(db as never, {} as CronLeaveResetService);
    await (service as unknown as { expireUnusedMonthlyLeaves(orgId: string): Promise<unknown> }).expireUnusedMonthlyLeaves("o1");

    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(insertValuesSpy).toHaveBeenCalledTimes(1);
    const ledgerRows = insertValuesSpy.mock.calls[0]?.[0] as Array<{ userId: string }>;
    expect(ledgerRows).toHaveLength(3);
  });
});
