import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { ReconciliationService } from "./reconciliation.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

function makeUser(orgId: string): CurrentUserContext {
  return { orgId, userId: "user-1", role: "MEMBER", isOrgOwner: false, enabledModules: [] } as unknown as CurrentUserContext;
}

describe("ReconciliationService — cross-tenant isolation", () => {
  it("throws NotFoundException when the transaction belongs to a different org (BOLA isolation)", async () => {
    const db = {
      query: {
        finBankTransactions: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
    } as unknown as Db;
    const svc = new ReconciliationService(db, {} as never, {} as never, {} as never, {} as never);

    await expect(
      svc.confirmMatch(makeUser("org-attacker"), 99, { transactionId: 1, matchType: "MANUAL", journalEntryId: null, invoiceIds: null }),
    ).rejects.toThrow(NotFoundException);
  });

  it("does not throw NotFoundException for the owning org (same-tenant control)", async () => {
    const txn = { id: 1, orgId: "org-owner", bankAccountId: 99, status: "UNMATCHED", amount: "100.00" };
    const db = {
      query: {
        finBankTransactions: { findFirst: jest.fn().mockResolvedValue(txn) },
        finBankAccounts: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      transaction: jest.fn().mockResolvedValue(undefined),
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }) }),
    } as unknown as Db;
    const cache = { invalidateForOrg: jest.fn(), cachedVersioned: jest.fn() } as never;
    const dispatch = { emit: jest.fn() } as never;
    const audit = { log: jest.fn() } as never;
    const svc = new ReconciliationService(db, {} as never, cache, dispatch, audit);

    const err = await svc.confirmMatch(makeUser("org-owner"), 99, { transactionId: 1, matchType: "MANUAL", journalEntryId: null, invoiceIds: null }).catch(e => e);

    expect(err).not.toBeInstanceOf(NotFoundException);
  });
});
