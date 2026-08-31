jest.mock("../../../../common/tenant", () => ({
  forEachOrg: jest.fn(),
}));
jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (_db: unknown, fn: (tx: unknown) => unknown, opts: { orgId: string }) =>
    fn(_db),
  runInNewTenantTransaction: jest.fn().mockImplementation(
    (_db: unknown, _orgId: string, fn: () => Promise<unknown>) => fn(),
  ),
}));

import { forEachOrg } from "../../../../common/tenant";
import { AiCreditsReservationService } from "../ai-credits-reservation.service";

const mockForEachOrg = forEachOrg as jest.Mock;

function tenantTx(leaf: Record<string, unknown>) {
  return {
    ...leaf,
    execute: jest.fn().mockResolvedValue([]),
    transaction: jest.fn().mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) => fn(leaf),
    ),
  };
}

function makeDb(overrides: Record<string, unknown> = {}) {
  return {
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    transaction: jest.fn(),
    ...overrides,
  };
}

describe("sweepExpiredReservations — RLS guard (bite-proof)", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("bites: returning 0 when forEachOrg calls no orgs (RLS sees nothing)", async () => {
    mockForEachOrg.mockResolvedValue({ organizations: 0, succeeded: 0, failed: 0 });
    const db = makeDb();
    const svc = new (AiCreditsReservationService as unknown as new (
      db: unknown,
    ) => AiCreditsReservationService)(db);

    const count = await svc.sweepExpiredReservations();
    expect(count).toBe(0);
    expect(mockForEachOrg).toHaveBeenCalledTimes(1);
    expect(mockForEachOrg).toHaveBeenCalledWith(
      db,
      "sweep:expired-ai-reservations",
      expect.any(Function),
    );
  });

  it("releases exactly the expired rows found inside the per-org tenant context", async () => {
    const reservationRows = [{ id: 42 }, { id: 43 }];
    const walletRow = { orgId: "org1", balance: 5000 };

    mockForEachOrg.mockImplementation(
      async (
        _db: unknown,
        _name: string,
        fn: (tx: unknown, orgId: string) => Promise<void>,
      ) => {
        const selectForUpdate = jest.fn().mockResolvedValue([walletRow]);
        const whereForUpdate = jest.fn().mockReturnValue({ for: () => selectForUpdate() });
        const fromForUpdate = jest.fn().mockReturnValue({ where: whereForUpdate });

        const selectExpired = jest.fn().mockResolvedValue([]);
        const whereExpired = jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue(reservationRows),
        });
        const fromExpired = jest.fn().mockReturnValue({ where: whereExpired });

        let selectCall = 0;
        const txSelect = jest.fn().mockImplementation(() => {
          if (selectCall++ === 0) return { from: fromExpired };
          return { from: fromForUpdate };
        });
        const txUpdate = jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
        });

        const reservationRow = {
          id: 42,
          orgId: "org1",
          credits: 200,
          status: "RESERVED",
          expiresAt: new Date(),
        };
        const innerSelectFn = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              for: jest.fn().mockResolvedValue([reservationRow]),
            }),
          }),
        });

        const innerTx = tenantTx({
          select: innerSelectFn,
          update: txUpdate,
        });

        const outerTxForRelease = tenantTx({
          select: jest.fn().mockReturnValueOnce({
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                for: jest.fn().mockResolvedValue([reservationRow]),
              }),
            }),
          }).mockReturnValue({
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                for: jest.fn().mockResolvedValue([walletRow]),
              }),
            }),
          }),
          update: txUpdate,
          transaction: jest.fn().mockImplementation(
            (cb: (tx: unknown) => Promise<unknown>) => cb(innerTx),
          ),
        });

        const tx = tenantTx({
          select: txSelect,
          update: txUpdate,
          transaction: jest.fn().mockImplementation(
            (cb: (tx: unknown) => Promise<unknown>) => cb(outerTxForRelease),
          ),
        });

        await fn(tx, "org1");
        return { organizations: 1, succeeded: 1, failed: 0 };
      },
    );

    const db = makeDb({
      transaction: jest.fn().mockResolvedValue(undefined),
    });
    const svc = new (AiCreditsReservationService as unknown as new (
      db: unknown,
    ) => AiCreditsReservationService)(db);

    const count = await svc.sweepExpiredReservations();
    expect(count).toBe(2);
  });

  it("does NOT touch this.db.select directly (proves the RLS bypass is gone)", async () => {
    const rawSelect = jest.fn();
    mockForEachOrg.mockResolvedValue({ organizations: 0, succeeded: 0, failed: 0 });

    const db = makeDb({ select: rawSelect });
    const svc = new (AiCreditsReservationService as unknown as new (
      db: unknown,
    ) => AiCreditsReservationService)(db);

    await svc.sweepExpiredReservations();
    expect(rawSelect).not.toHaveBeenCalled();
  });
});
