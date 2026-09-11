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
    /*
     * Ticket 21 replaced the per-row `runInNewTenantTransaction` release with a
     * set-based claim inside forEachOrg's own transaction, so the shape under
     * test is now: one page select, one compare-and-set claim returning the
     * refunded credits, one atomic wallet increment. The property this test
     * exists for is unchanged — the sweep must only ever touch the rows the
     * per-org tenant context handed it, never `this.db` directly.
     */
    const expiredRows = [{ id: 42 }, { id: 43 }];
    const claimedRows = [{ credits: 200 }, { credits: 300 }];
    let claimWhere: unknown;
    let walletSet: Record<string, unknown> | undefined;

    mockForEachOrg.mockImplementation(
      async (
        _db: unknown,
        _name: string,
        fn: (tx: unknown, orgId: string) => Promise<void>,
      ) => {
        const txSelect = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue(expiredRows),
            }),
          }),
        });

        let updateCall = 0;
        const txUpdate = jest.fn().mockImplementation(() => {
          const isClaim = updateCall++ === 0;
          return {
            set: jest.fn().mockImplementation((values: Record<string, unknown>) => {
              if (!isClaim) walletSet = values;
              return {
                where: jest.fn().mockImplementation((predicate: unknown) => {
                  if (isClaim) claimWhere = predicate;
                  return isClaim
                    ? { returning: jest.fn().mockResolvedValue(claimedRows) }
                    : Promise.resolve([]);
                }),
              };
            }),
          };
        });

        await fn(tenantTx({ select: txSelect, update: txUpdate }), "org1");
        return { organizations: 1, succeeded: 1, failed: 0 };
      },
    );

    const db = makeDb({
      select: jest.fn(() => {
        throw new Error("sweep read this.db directly — the RLS bypass is back");
      }),
      transaction: jest.fn().mockResolvedValue(undefined),
    });
    const svc = new (AiCreditsReservationService as unknown as new (
      db: unknown,
    ) => AiCreditsReservationService)(db);

    const count = await svc.sweepExpiredReservations();
    expect(count).toBe(2);
    expect(claimWhere).toBeDefined();
    // The refund is atomic SQL over the column, not a number computed in JS.
    expect(typeof walletSet?.["balance"]).toBe("object");
    expect(db.select).not.toHaveBeenCalled();
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
