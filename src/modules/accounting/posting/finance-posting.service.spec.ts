import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { FinancePostingService } from "./finance-posting.service";
import { FinancePostingAccountsService } from "./finance-posting-accounts.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { PostJournalInput } from "../core/finance-posting.types";
import { ACCT_STATEMENTS_NS } from "../settings/accounting-settings.constants";

const USER: CurrentUserContext = {
  userId: "u1",
  orgId: "org1",
  role: "ADMIN",
  isOrgOwner: false,
  sessionId: "sess1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

/**
 * A select double that answers whether the caller ends on `.limit()` or awaits
 * `.where()` directly. `finApprovalPolicies` and the reversal's line read do the
 * latter, so a `where: mockReturnThis()` chain hands them the builder itself.
 */
function selectChain(rows: unknown[], limitRows: unknown[] = rows) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  Object.assign(builder, {
    from: chain,
    where: chain,
    limit: () => Promise.resolve(limitRows),
    then: (resolve: (value: unknown[]) => unknown) => resolve(rows),
  });
  return builder;
}

function makeBalancedInput(overrides: Partial<PostJournalInput> = {}): PostJournalInput {
  return {
    entryDate: "2024-01-15",
    description: "Test journal",
    sourceType: "manual",
    sourceId: "src1",
    sourceEvent: "create",
    lines: [
      { accountId: 1, debit: "100.00", credit: "0" },
      { accountId: 2, debit: "0", credit: "100.00" },
    ],
    ...overrides,
  };
}

describe("FinancePostingService", () => {
  let service: FinancePostingService;
  let accountsService: FinancePostingAccountsService;
  let mockDb: {
    select: jest.Mock;
    insert: jest.Mock;
    transaction: jest.Mock;
    query: { finReconciliationMatches: { findFirst: jest.Mock } };
  };
  let mockAudit: { log: jest.Mock };
  let mockDispatch: { emit: jest.Mock };
  let mockCache: { invalidateNamespace: jest.Mock };

  beforeEach(async () => {
    const selectChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };

    mockDb = {
      select: jest.fn().mockReturnValue(selectChain),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnThis(),
        onConflictDoNothing: jest.fn().mockReturnThis(),
        onConflictDoUpdate: jest.fn().mockReturnThis(),
        returning: jest.fn().mockResolvedValue([{ id: 42, entryNumber: "JE-202401-00001" }]),
      }),
      transaction: jest.fn(),
      query: {
        finReconciliationMatches: { findFirst: jest.fn() },
      },
    };

    mockAudit = { log: jest.fn() };
    mockDispatch = { emit: jest.fn().mockResolvedValue(undefined) };

    mockCache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        FinancePostingService,
        FinancePostingAccountsService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AuditService, useValue: mockAudit },
        { provide: NotificationDispatchService, useValue: mockDispatch },
        { provide: CacheService, useValue: mockCache },
      ],
    }).compile();

    service = module.get(FinancePostingService);
    accountsService = module.get(FinancePostingAccountsService);
  });

  describe("postJournal — balance check", () => {
    it("rejects unbalanced lines (debit != credit)", async () => {
      const input = makeBalancedInput({
        lines: [
          { accountId: 1, debit: "100.00", credit: "0" },
          { accountId: 2, debit: "0", credit: "99.99" },
        ],
      });
      await expect(service.postJournal(USER, input)).rejects.toThrow(
        "Journal entry debits do not equal credits",
      );
    });

    it("rejects entry with fewer than 2 lines", async () => {
      const input = makeBalancedInput({
        lines: [{ accountId: 1, debit: "100.00", credit: "100.00" }],
      });
      await expect(service.postJournal(USER, input)).rejects.toThrow(
        "at least 2 lines",
      );
    });
  });

  describe("postJournal — period guard", () => {
    function setupPeriodStatus(status: string) {
      mockDb.select.mockImplementation(() => ({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([{ status }]),
      }));
    }

    it("rejects posting into a CLOSED period", async () => {
      setupPeriodStatus("CLOSED");
      await expect(service.postJournal(USER, makeBalancedInput())).rejects.toThrow(
        /closed/i,
      );
    });

    it("rejects posting into a LOCKED period", async () => {
      setupPeriodStatus("LOCKED");
      await expect(service.postJournal(USER, makeBalancedInput())).rejects.toThrow(
        /locked/i,
      );
    });

    it("throws when no period covers the date", async () => {
      mockDb.select.mockImplementation(() => ({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      }));
      await expect(service.postJournal(USER, makeBalancedInput())).rejects.toThrow(
        /No accounting period/i,
      );
    });
  });

  describe("postJournal — idempotent replay", () => {
    it("returns replayed:true without insert when source tuple already exists", async () => {
      const existingEntry = { id: 99, entryNumber: "JE-202401-00001" };

      mockDb.select.mockImplementation(() => ({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([{ status: "OPEN" }]),
      }));

      mockDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const txSelect = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          limit: jest.fn().mockResolvedValue([existingEntry]),
        });
        const tx = {
          select: txSelect,
          insert: jest.fn(),
          update: jest.fn(),
        };
        return fn(tx);
      });

      const result = await service.postJournal(USER, makeBalancedInput());
      expect(result.replayed).toBe(true);
      expect(result.entryId).toBe(existingEntry.id);
    });
  });

  describe("postJournal — multi-currency", () => {
    it("requires exchangeRate when currency differs from base", async () => {
      mockDb.select.mockImplementation(() => ({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([{ status: "OPEN" }]),
      }));

      await expect(
        service.postJournal(USER, makeBalancedInput({ currency: "USD" })),
      ).rejects.toThrow(/exchangeRate is required/i);
    });

    it("does not throw exchangeRate error when currency is undefined (defaults to base)", async () => {
      mockDb.select.mockImplementation(() => ({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([{ status: "OPEN" }]),
      }));

      mockDb.transaction.mockRejectedValue(new Error("tx-not-needed-for-this-assertion"));

      await expect(
        service.postJournal(USER, makeBalancedInput({ currency: undefined, exchangeRate: undefined })),
      ).rejects.toThrow("tx-not-needed-for-this-assertion");
    });
  });

  describe("reverseJournal", () => {
    it("rejects reversal of non-POSTED entry", async () => {
      mockDb.select.mockImplementation(() => ({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([{ status: "OPEN" }]),
      }));

      mockDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          select: jest.fn().mockReturnValue({
            from: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            limit: jest.fn().mockResolvedValue([
              {
                id: 1,
                orgId: "org1",
                status: "DRAFT",
                entryNumber: "JE-202401-00001",
                sourceType: "manual",
                sourceId: "s1",
                currency: "INR",
              },
            ]),
          }),
          insert: jest.fn(),
          update: jest.fn(),
        };
        return fn(tx);
      });

      await expect(service.reverseJournal(USER, 1)).rejects.toThrow(
        /Only POSTED entries can be reversed/i,
      );
    });

    it("rejects double reversal (entry already VOID)", async () => {
      mockDb.select.mockImplementation(() => ({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([{ status: "OPEN" }]),
      }));

      mockDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          select: jest.fn().mockReturnValue({
            from: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            limit: jest.fn().mockResolvedValue([
              {
                id: 1,
                orgId: "org1",
                status: "VOID",
                entryNumber: "JE-202401-00001",
                sourceType: "manual",
                sourceId: "s1",
                currency: "INR",
              },
            ]),
          }),
          insert: jest.fn(),
          update: jest.fn(),
        };
        return fn(tx);
      });

      await expect(service.reverseJournal(USER, 1)).rejects.toThrow(
        /Only POSTED entries can be reversed/i,
      );
    });
  });

  describe("postJournal — cache invalidation after commit", () => {
    function setupSuccessfulPost() {
      let outerCallCount = 0;
      mockDb.select.mockImplementation(() => ({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockImplementation(() => {
          outerCallCount++;
          if (outerCallCount === 1) return Promise.resolve([{ status: "OPEN" }]);
          return Promise.resolve([{ baseCurrency: "INR" }]);
        }),
      }));

      mockDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const txSelect = jest.fn().mockImplementation(() => selectChain([]));
        const txInsert = jest.fn()
          .mockReturnValueOnce({
            values: jest.fn().mockReturnThis(),
            onConflictDoNothing: jest.fn().mockReturnThis(),
            onConflictDoUpdate: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([{ next: 2, padding: 5 }]),
          })
          .mockReturnValueOnce({
            values: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([{ id: 42, entryNumber: "JE-202401-00001" }]),
          })
          .mockReturnValue({
            values: jest.fn().mockResolvedValue(undefined),
          });
        return fn({ select: txSelect, insert: txInsert, update: jest.fn() });
      });
    }

    it("bumps finReportsNamespace after a direct post", async () => {
      setupSuccessfulPost();
      await service.postJournal(USER, makeBalancedInput({ sourceType: "invoice" }));
      const allKeys = mockCache.invalidateNamespace.mock.calls.map((c: unknown[]) => c[0]);
      expect(allKeys).toContain(CACHE_KEYS.finReportsNamespace(USER.orgId));
    });

    it("bumps ACCT_STATEMENTS_NS and finReportsNamespace together", async () => {
      setupSuccessfulPost();
      await service.postJournal(USER, makeBalancedInput({ sourceType: "invoice" }));
      const allKeys = mockCache.invalidateNamespace.mock.calls.map((c: unknown[]) => c[0]);
      expect(allKeys).toContain(ACCT_STATEMENTS_NS(USER.orgId));
      expect(allKeys).toContain(CACHE_KEYS.finReportsNamespace(USER.orgId));
    });

    it("does not bump finReportsNamespace when entry is pending approval", async () => {
      let outerCallCount = 0;
      mockDb.select.mockImplementation(() => ({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockImplementation(() => {
          outerCallCount++;
          if (outerCallCount === 1) return Promise.resolve([{ status: "OPEN" }]);
          return Promise.resolve([{ baseCurrency: "INR" }]);
        }),
      }));

      mockDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const txSelect = jest.fn().mockImplementation(() => selectChain([]));
        const txSelectApproval = jest
          .fn()
          .mockImplementation(() => selectChain([{ id: 1, approverUserId: null, minAmount: null }]));

        const txInsert = jest.fn()
          .mockReturnValueOnce({
            values: jest.fn().mockReturnThis(),
            onConflictDoNothing: jest.fn().mockReturnThis(),
            onConflictDoUpdate: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([{ next: 2, padding: 5 }]),
          })
          .mockReturnValueOnce({
            values: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([{ id: 42, entryNumber: "JE-202401-00001" }]),
          })
          .mockReturnValue({
            values: jest.fn().mockResolvedValue(undefined),
          });

        let selectCallCount = 0;
        const combinedSelect = jest.fn().mockImplementation(() => {
          selectCallCount++;
          if (selectCallCount === 1) return txSelect();
          return txSelectApproval();
        });

        return fn({ select: combinedSelect, insert: txInsert, update: jest.fn() });
      });

      await service.postJournal(USER, makeBalancedInput({ sourceType: "manual" }));
      expect(mockCache.invalidateNamespace).not.toHaveBeenCalled();
    });
  });

  describe("reverseJournal — cache invalidation after commit", () => {
    it("bumps finReportsNamespace after reversal", async () => {
      mockDb.select.mockImplementation(() => ({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([{ status: "OPEN" }]),
      }));

      mockDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const postedEntry = {
          id: 10,
          orgId: USER.orgId,
          status: "POSTED",
          entryNumber: "JE-202401-00001",
          sourceType: "invoice",
          sourceId: "s1",
          sourceEvent: "create",
          currency: "INR",
        };
        const reversalLine = {
          accountId: 1,
          debit: "100.00",
          credit: "0",
          description: null,
          lineOrder: 0,
          currency: null,
          exchangeRate: null,
          clientId: null,
          vendorId: null,
          projectId: null,
          departmentId: null,
          employeeId: null,
          taxCodeId: null,
          dimensionValues: null,
        };
        const txSelect = jest
          .fn()
          .mockImplementationOnce(() => selectChain([], [postedEntry]))
          .mockImplementation(() => selectChain([reversalLine], []));
        const txInsert = jest.fn()
          .mockReturnValueOnce({
            values: jest.fn().mockReturnThis(),
            onConflictDoNothing: jest.fn().mockReturnThis(),
            onConflictDoUpdate: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([{ next: 3, padding: 5 }]),
          })
          .mockReturnValue({
            values: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([{ id: 99 }]),
          });
        const txUpdate = jest.fn().mockReturnValue({
          set: jest.fn().mockReturnThis(),
          where: jest.fn().mockResolvedValue(undefined),
        });
        return fn({ select: txSelect, insert: txInsert, update: txUpdate });
      });

      await service.reverseJournal(USER, 10);
      const allKeys = mockCache.invalidateNamespace.mock.calls.map((c: unknown[]) => c[0]);
      expect(allKeys).toContain(CACHE_KEYS.finReportsNamespace(USER.orgId));
      expect(allKeys).toContain(ACCT_STATEMENTS_NS(USER.orgId));
    });
  });

  describe("FinancePostingAccountsService.resolveSystemAccount — self-heal", () => {
    it("returns existing mapped account id without insert", async () => {
      mockDb.select.mockImplementation(() => ({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([{ accountId: 55 }]),
      }));

      const id = await accountsService.resolveSystemAccount("org1", "AR");
      expect(id).toBe(55);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("falls back to code lookup and inserts mapping when map miss", async () => {
      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => ({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockImplementation(() => {
          selectCallCount++;
          if (selectCallCount === 1) return Promise.resolve([]);
          return Promise.resolve([{ id: 77 }]);
        }),
      }));

      const insertReturn = {
        values: jest.fn().mockReturnThis(),
        onConflictDoNothing: jest.fn().mockResolvedValue([]),
      };
      mockDb.insert.mockReturnValue(insertReturn);

      const id = await accountsService.resolveSystemAccount("org1", "AR");
      expect(id).toBe(77);
      expect(mockDb.insert).toHaveBeenCalledTimes(1);
    });

    it("throws BadRequestException when default code account not found", async () => {
      mockDb.select.mockImplementation(() => ({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      }));

      await expect(accountsService.resolveSystemAccount("org1", "AR")).rejects.toThrow(BadRequestException);
    });
  });
});
