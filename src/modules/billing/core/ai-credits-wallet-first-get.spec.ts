jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (_db: unknown, fn: (tx: unknown) => unknown) => fn(_db),
  runInNewTenantTransaction: (_db: unknown, _orgId: string, fn: (tx: unknown) => unknown) => fn(_db),
}));

import { AiCreditsReservationService } from "./ai-credits-reservation.service";
import type { Db } from "../../../db/drizzle.module";

const TRIAL_WALLET = {
  id: 1,
  orgId: "org-first",
  balance: 5000,
  lifetimeGranted: 5000,
  lifetimeConsumed: 0,
  autoTopUpEnabled: false,
  autoTopUpPackId: null,
  autoTopUpThreshold: null,
  updatedAt: new Date(),
};

describe("AiCreditsReservationService.ensureWalletForOrg — first-GET wallet creation", () => {
  function makeNoWalletDb(): { db: Db; insertSpy: jest.Mock } {
    const insertSpy = jest.fn();
    const onConflictDoNothing = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([TRIAL_WALLET]),
    });
    const values = jest.fn().mockReturnValue({ onConflictDoNothing });
    insertSpy.mockReturnValue({ values });

    const forChain: unknown[] = [];
    const where = jest.fn().mockReturnValue({
      for: jest.fn().mockResolvedValue(forChain),
    });
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });

    const db = {
      select,
      insert: insertSpy,
      execute: jest.fn().mockResolvedValue([]),
    } as unknown as Db;
    return { db, insertSpy };
  }

  it("creates the first wallet in its own fresh transaction so a GET route under read-only accessMode does not veto the INSERT with SQLSTATE 25006", async () => {
    const { db, insertSpy } = makeNoWalletDb();
    const svc = new AiCreditsReservationService(db);

    const result = await svc.ensureWalletForOrg("org-first");

    expect(insertSpy).toHaveBeenCalledTimes(2);
    expect(result.orgId).toBe(TRIAL_WALLET.orgId);
    expect(result.balance).toBe(TRIAL_WALLET.balance);
  });

  it("returns the existing wallet without inserting when the row is already present", async () => {
    const insertSpy = jest.fn();
    const where = jest.fn().mockReturnValue({
      for: jest.fn().mockResolvedValue([TRIAL_WALLET]),
    });
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });

    const db = {
      select,
      insert: insertSpy,
      execute: jest.fn().mockResolvedValue([]),
    } as unknown as Db;
    const svc = new AiCreditsReservationService(db);

    const result = await svc.ensureWalletForOrg("org-first");

    expect(insertSpy).not.toHaveBeenCalled();
    expect(result.orgId).toBe(TRIAL_WALLET.orgId);
  });
});
