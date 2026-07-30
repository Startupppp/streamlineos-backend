import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { FinancePostingService } from "./finance-posting.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { AuditService } from "../../common/audit/audit.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { PostJournalInput } from "./finance-posting.types";

const USER: CurrentUserContext = {
  userId: "u1",
  orgId: "org1",
  branchId: null,
  role: "ADMIN",
  permissions: [],
  enabledModules: [],
  plan: null,
  isOrgOwner: false,
  sessionId: "sess1",
};

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
  let mockDb: {
    select: jest.Mock;
    insert: jest.Mock;
    transaction: jest.Mock;
    query: { finReconciliationMatches: { findFirst: jest.Mock } };
  };
  let mockAudit: { log: jest.Mock };
  let mockDispatch: { emit: jest.Mock };

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

    const module = await Test.createTestingModule({
      providers: [
        FinancePostingService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AuditService, useValue: mockAudit },
        { provide: NotificationDispatchService, useValue: mockDispatch },
      ],
    }).compile();

    service = module.get(FinancePostingService);
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

  describe("resolveSystemAccount — self-heal", () => {
    it("returns existing mapped account id without insert", async () => {
      mockDb.select.mockImplementation(() => ({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([{ accountId: 55 }]),
      }));

      const id = await service.resolveSystemAccount("org1", "AR");
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

      const id = await service.resolveSystemAccount("org1", "AR");
      expect(id).toBe(77);
      expect(mockDb.insert).toHaveBeenCalledTimes(1);
    });

    it("throws BadRequestException when default code account not found", async () => {
      mockDb.select.mockImplementation(() => ({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      }));

      await expect(service.resolveSystemAccount("org1", "AR")).rejects.toThrow(BadRequestException);
    });
  });
});
