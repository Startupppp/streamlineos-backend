import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { PostJournalInput } from "../core/finance-posting.types";

const USER: CurrentUserContext = {
  userId: "u1",
  orgId: "org1",
  role: "ADMIN",
  isOrgOwner: false,
  sessionId: "sess1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

describe("FxService.postRealizedGainLoss — retry safety", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("run-twice: zero diff skips postJournal both times — no journal entry created", async () => {
    const { FxService } = await import("../../finance/controls/fx.service");
    const postJournalMock = jest.fn().mockResolvedValue({ entryId: 1, entryNumber: "JE-001", replayed: false });
    const fxSvc = new FxService({ postJournal: postJournalMock } as never);

    const input = {
      sourceType: "purchase_bill" as const,
      sourceId: "42",
      baseAmountBooked: "100.0000",
      baseAmountSettled: "100.0000",
      counterPurpose: "AP" as const,
    };

    await fxSvc.postRealizedGainLoss(USER, input);
    await fxSvc.postRealizedGainLoss(USER, input);

    expect(postJournalMock).not.toHaveBeenCalled();
  });

  it("run-twice: FxService delegates consistent key to postJournal — idempotency comes from postJournal replay", async () => {
    const { FxService } = await import("../../finance/controls/fx.service");

    let callCount = 0;
    const postJournalMock = jest.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        entryId: callCount === 1 ? 1 : 1,
        entryNumber: "JE-001",
        replayed: callCount > 1,
      });
    });

    const fxSvc = new FxService({ postJournal: postJournalMock } as never);

    const input = {
      sourceType: "purchase_bill" as const,
      sourceId: "7",
      baseAmountBooked: "100.0000",
      baseAmountSettled: "105.0000",
      counterPurpose: "AP" as const,
    };

    await fxSvc.postRealizedGainLoss(USER, input);
    await fxSvc.postRealizedGainLoss(USER, input);

    expect(postJournalMock).toHaveBeenCalledTimes(2);
    const firstArg = postJournalMock.mock.calls[0]?.[1] as PostJournalInput;
    const secondArg = postJournalMock.mock.calls[1]?.[1] as PostJournalInput;

    expect(firstArg.sourceType).toBe("fx_settlement");
    expect(firstArg.sourceId).toBe("7");
    expect(firstArg.sourceEvent).toBe("realized_gain_loss");

    expect(secondArg.sourceType).toBe(firstArg.sourceType);
    expect(secondArg.sourceId).toBe(firstArg.sourceId);
    expect(secondArg.sourceEvent).toBe(firstArg.sourceEvent);
  });

  it("run-twice: FinancePostingService.postJournal returns replayed=true on second call for same source", async () => {
    const { FinancePostingService } = await import("./finance-posting.service");
    const { FinancePostingAccountsService } = await import("./finance-posting-accounts.service");
    const { Test } = await import("@nestjs/testing");
    const { DRIZZLE } = await import("../../../db/drizzle.constants");
    const { AuditService } = await import("../../../common/audit/audit.service");
    const { CacheService } = await import("../../../common/cache/cache.service");
    const { NotificationDispatchService } = await import("../../notifications/notification-dispatch.service");

    const existingEntry = { id: 99, entryNumber: "JE-202401-00099" };

    const makeSelect = (result: unknown[]) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      Object.assign(chain, {
        from: self,
        where: self,
        limit: () => Promise.resolve(result),
        then: (resolve: (v: unknown[]) => unknown) => resolve(result),
      });
      return chain;
    };

    const makeInsert = (ret: unknown[]) => {
      const chain: Record<string, unknown> = {};
      chain.values = jest.fn().mockReturnValue(chain);
      chain.onConflictDoUpdate = jest.fn().mockReturnValue(chain);
      chain.onConflictDoNothing = jest.fn().mockReturnValue(chain);
      chain.returning = jest.fn().mockResolvedValue(ret);
      chain.then = (resolve: (v: unknown[]) => unknown) => resolve(ret);
      return chain;
    };

    let txCallNumber = 0;
    const lineInsertMock = jest.fn();

    const mockDb = {
      select: jest.fn().mockImplementation(() => makeSelect([{ status: "OPEN" }])),
      insert: jest.fn(),
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        txCallNumber++;
        const isFirst = txCallNumber === 1;
        let innerSelectCount = 0;

        const tx = {
          select: jest.fn().mockImplementation(() => {
            innerSelectCount++;
            if (innerSelectCount === 1) return makeSelect(isFirst ? [] : [existingEntry]);
            return makeSelect([]);
          }),
          insert: (() => {
            let insertCount = 0;
            return jest.fn().mockImplementation(() => {
              insertCount++;
              if (insertCount === 1) return makeInsert([{ next: 2, padding: 5 }]);
              if (insertCount === 2) return makeInsert([{ id: 99, entryNumber: "JE-202401-00099" }]);
              lineInsertMock();
              return makeInsert([]);
            });
          })(),
          execute: jest.fn().mockResolvedValue([{ nextNumber: 2 }]),
          update: jest.fn().mockReturnValue({
            set: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnThis(),
              returning: jest.fn().mockResolvedValue([]),
            }),
          }),
          query: { finReconciliationMatches: { findFirst: jest.fn().mockResolvedValue(null) } },
        };
        return fn(tx);
      }),
      query: { finReconciliationMatches: { findFirst: jest.fn().mockResolvedValue(null) } },
    };

    const module = await Test.createTestingModule({
      providers: [
        FinancePostingService,
        FinancePostingAccountsService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: NotificationDispatchService, useValue: { emit: jest.fn().mockResolvedValue(undefined) } },
        { provide: CacheService, useValue: { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    const svc = module.get(FinancePostingService);

    const input: PostJournalInput = {
      entryDate: "2024-01-15",
      description: "Realized FX gain on purchase_bill 42",
      sourceType: "fx_settlement",
      sourceId: "42",
      sourceEvent: "realized_gain_loss",
      lines: [
        { accountId: 101, debit: "5.0000" },
        { accountId: 102, credit: "5.0000" },
      ],
    };

    const firstResult = await svc.postJournal(USER, input);
    const secondResult = await svc.postJournal(USER, input);

    expect(firstResult.replayed).toBe(false);
    expect(secondResult.replayed).toBe(true);
    expect(firstResult.entryId).toBe(secondResult.entryId);
  });
});
