import type { Db } from "../../../db/drizzle.module";
import { ReconciliationService } from "./reconciliation.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const ORG = "org-1";
const BANK_ACCOUNT_ID = 4;
const TRANSACTION_ID = 21;

const user: CurrentUserContext = {
  userId: "user-1",
  orgId: ORG,
  role: "FINANCE",
  isOrgOwner: false,
  sessionId: "s-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

describe("ignoring a bank transaction invalidates the reconciliation workspace it changes", () => {
  function makeService(status: string) {
    const invalidate = jest.fn().mockResolvedValue(undefined);
    const db = {
      query: {
        finBankTransactions: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: TRANSACTION_ID, orgId: ORG, bankAccountId: BANK_ACCOUNT_ID, status }),
        },
      },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
      }),
    } as unknown as Db;

    const service = new ReconciliationService(
      db,
      {} as never,
      { invalidate } as never,
      { emit: jest.fn() } as never,
      { log: jest.fn() } as never,
    );
    return { service, invalidate };
  }

  it("invalidates the same cache key the workspace read is served from", async () => {
    const { service, invalidate } = makeService("UNMATCHED");

    await service.ignoreTransaction(user, BANK_ACCOUNT_ID, {
      transactionId: TRANSACTION_ID,
    } as never);

    expect(invalidate).toHaveBeenCalledWith(`fin:banking:recon:${ORG}:${BANK_ACCOUNT_ID}`);
  });

  it("does not invalidate when the transaction is refused as already reconciled", async () => {
    const { service, invalidate } = makeService("RECONCILED");

    await expect(
      service.ignoreTransaction(user, BANK_ACCOUNT_ID, { transactionId: TRANSACTION_ID } as never),
    ).rejects.toThrow();

    expect(invalidate).not.toHaveBeenCalled();
  });
});
