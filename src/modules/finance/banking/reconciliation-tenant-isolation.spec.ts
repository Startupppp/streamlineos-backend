import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { ReconciliationService } from "./reconciliation.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

function makeUser(orgId: string): CurrentUserContext {
  return { orgId, userId: "user-1", role: "MEMBER", isOrgOwner: false, enabledModules: [] } as unknown as CurrentUserContext;
}

/*
 * checkApprovalPolicy awaits `.where(...)` directly, with no `.limit()`. A chain
 * that only answers `.limit()` returns the builder object itself, `policies.find`
 * is not a function, and the whole method dies on a TypeError before it ever
 * reaches the transaction — which the old assertion (`err is not a
 * NotFoundException`) could not tell apart from success.
 */
function emptyRows() {
  return {
    limit: jest.fn().mockResolvedValue([]),
    then: (resolve: (value: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
  };
}

describe("ReconciliationService — cross-tenant isolation", () => {
  it("throws NotFoundException when the transaction belongs to a different org (BOLA isolation)", async () => {
    const db = {
      query: {
        finBankTransactions: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      transaction: jest.fn(),
    };
    const svc = new ReconciliationService(db as unknown as Db, {} as never, {} as never, {} as never, {} as never);

    await expect(
      svc.confirmMatch(makeUser("org-attacker"), 99, { transactionId: 1, matchType: "MANUAL_JOURNAL" }),
    ).rejects.toThrow(NotFoundException);

    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("clears the tenant check for the owning org and runs the match inside the transaction", async () => {
    const txn = { id: 1, orgId: "org-owner", bankAccountId: 99, status: "UNMATCHED", amount: "100.00" };
    const txFindFirst = jest.fn().mockResolvedValue(undefined);
    const tx = { query: { finBankAccounts: { findFirst: txFindFirst } } };
    const db = {
      query: {
        finBankTransactions: { findFirst: jest.fn().mockResolvedValue(txn) },
        finBankAccounts: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      transaction: jest
        .fn()
        .mockImplementation((work: (t: typeof tx) => Promise<unknown>) => work(tx)),
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue(emptyRows()) }) }),
    };
    const cache = { invalidateForOrg: jest.fn(), cachedVersioned: jest.fn() } as never;
    const dispatch = { emit: jest.fn() } as never;
    const audit = { log: jest.fn() } as never;
    const svc = new ReconciliationService(db as unknown as Db, {} as never, cache, dispatch, audit);

    const err = await svc.confirmMatch(makeUser("org-owner"), 99, { transactionId: 1, matchType: "MANUAL_JOURNAL" }).catch(e => e);

    expect(err).not.toBeInstanceOf(NotFoundException);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(txFindFirst).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toContain("no linked ledger account");
  });
});
