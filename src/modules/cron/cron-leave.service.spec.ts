import { CronLeaveService } from "./cron-leave.service";

const ORG = "org-1";
const NOW = new Date(2026, 7, 1);

const POLICY = { leaveTypeId: 10, accrualRate: "2.00", maxBalance: "30.00" };
const POLICY_NO_CEIL = { leaveTypeId: 11, accrualRate: "1.50", maxBalance: null };

function makeDb(
  policies: unknown[],
  members: unknown[],
  existingLedger: unknown[],
  existingBalances: unknown[],
) {
  const results = [policies, members, existingLedger, existingBalances];
  let resultIndex = 0;
  const chain: Record<string, unknown> = {
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(results[resultIndex++]).then(resolve),
  };
  const where = jest.fn().mockReturnValue(chain);
  chain.where = where;

  const txOnConflict = jest.fn().mockResolvedValue(undefined);
  const txValues = jest.fn().mockReturnValue({ onConflictDoNothing: txOnConflict });
  const txInsert = jest.fn().mockReturnValue({ values: txValues });
  const txExecute = jest.fn().mockResolvedValue(undefined);

  const transaction = jest.fn().mockImplementation(
    async (cb: (tx: unknown) => Promise<void>) => cb({ insert: txInsert, execute: txExecute }),
  );

  const db = {
    select: jest.fn().mockReturnValue(chain),
    where,
    transaction,
  };

  return { db, where, transaction, txInsert, txValues, txOnConflict, txExecute };
}

type Accrue = { accruedCount: number };

function runAccrue(db: ReturnType<typeof makeDb>["db"], now: Date = NOW): Promise<Accrue> {
  const mockReset = { resolveLeaveYearStartMonth: jest.fn(), resetYearlyLeaveBalances: jest.fn() };
  const svc = new CronLeaveService(db as never, mockReset as never);
  return svc.accrueMonthlyLeaves(now, ORG);
}

describe("CronLeaveService.accrueMonthlyLeaves", () => {
  it("returns zero when no monthly policies exist", async () => {
    const { db } = makeDb([], [], [], []);
    expect(await runAccrue(db)).toEqual({ accruedCount: 0 });
  });

  it("returns zero when no active members exist", async () => {
    const { db } = makeDb([POLICY], [], [], []);
    expect(await runAccrue(db)).toEqual({ accruedCount: 0 });
  });

  it("accrues one ledger entry for an active member with no prior balance", async () => {
    const { db, txValues } = makeDb([POLICY], [{ userId: "u1" }], [], []);
    const result = await runAccrue(db);

    expect(result).toEqual({ accruedCount: 1 });
    const allCalls = txValues.mock.calls as unknown[][];
    const ledgerArg = allCalls[allCalls.length - 1]?.[0] as Array<{ days: string; userId: string }>;
    expect(ledgerArg?.[0]).toMatchObject({ userId: "u1", days: "2.00" });
  });

  it("skips a member already accrued for the period", async () => {
    const { db, transaction } = makeDb(
      [POLICY],
      [{ userId: "u1" }],
      [{ userId: "u1", leaveTypeId: 10 }],
      [],
    );
    expect(await runAccrue(db)).toEqual({ accruedCount: 0 });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("grants nothing when balance is at ceiling", async () => {
    const { db, transaction } = makeDb(
      [POLICY],
      [{ userId: "u1" }],
      [],
      [{ userId: "u1", leaveTypeId: 10, balance: "30.00" }],
    );
    expect(await runAccrue(db)).toEqual({ accruedCount: 0 });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("grants only the remainder when balance is just below ceiling", async () => {
    const { db, txValues, txExecute } = makeDb(
      [POLICY],
      [{ userId: "u1" }],
      [],
      [{ userId: "u1", leaveTypeId: 10, balance: "29.50" }],
    );
    const result = await runAccrue(db);

    expect(result).toEqual({ accruedCount: 1 });
    expect(txExecute).toHaveBeenCalledTimes(1);
    const allCalls = txValues.mock.calls as unknown[][];
    const ledgerArg = allCalls[0]?.[0] as Array<{ days: string }>;
    expect(ledgerArg?.[0]?.days).toBe("0.50");
  });

  it("accrues the full rate when no ceiling is set", async () => {
    const { db, txValues } = makeDb([POLICY_NO_CEIL], [{ userId: "u1" }], [], []);
    const result = await runAccrue(db);

    expect(result).toEqual({ accruedCount: 1 });
    const allCalls = txValues.mock.calls as unknown[][];
    const ledgerArg = allCalls[allCalls.length - 1]?.[0] as Array<{ days: string }>;
    expect(ledgerArg?.[0]?.days).toBe("1.50");
  });

  it("is idempotent: a second run writes nothing when all entries already exist", async () => {
    const { db: db1 } = makeDb([POLICY], [{ userId: "u1" }], [], []);
    expect(await runAccrue(db1)).toEqual({ accruedCount: 1 });

    const { db: db2, transaction } = makeDb(
      [POLICY],
      [{ userId: "u1" }],
      [{ userId: "u1", leaveTypeId: 10 }],
      [],
    );
    expect(await runAccrue(db2)).toEqual({ accruedCount: 0 });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("the transaction mock invokes its callback so assertions inside are not vacuous", async () => {
    let callbackInvoked = false;

    const where = jest.fn()
      .mockResolvedValueOnce([POLICY])
      .mockResolvedValueOnce([{ userId: "u1" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const txValues = jest.fn().mockReturnValue({ onConflictDoNothing: jest.fn().mockResolvedValue(undefined) });
    const txInsert = jest.fn().mockReturnValue({ values: txValues });
    const txExecute = jest.fn().mockResolvedValue(undefined);

    const transaction = jest.fn().mockImplementation(
      async (cb: (tx: unknown) => Promise<void>) => {
        callbackInvoked = true;
        await cb({ insert: txInsert, execute: txExecute });
      },
    );

    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([{ userId: "u1" }]),
              }),
            }),
          }),
        }),
      }),
      where,
      transaction,
    };

    await runAccrue(db);

    expect(callbackInvoked).toBe(true);
    expect(txInsert).toHaveBeenCalled();
  });

  it("reads members once regardless of how many policies exist", async () => {
    const { db, where } = makeDb(
      [POLICY, POLICY_NO_CEIL],
      [{ userId: "u1" }],
      [],
      [],
    );
    await runAccrue(db);

    expect(where).toHaveBeenCalledTimes(4);
  });

  it("skips a policy whose accrual rate is zero", async () => {
    const badPolicy = { leaveTypeId: 20, accrualRate: "0.00", maxBalance: null };
    const { db, transaction } = makeDb([badPolicy], [{ userId: "u1" }], [], []);
    expect(await runAccrue(db)).toEqual({ accruedCount: 0 });
    expect(transaction).not.toHaveBeenCalled();
  });
});
