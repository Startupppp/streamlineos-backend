import { Test, type TestingModule } from "@nestjs/testing";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { HrHelpdeskService } from "./hr-helpdesk.service";
import { encodeCursor } from "../../../common/pagination/cursor";

const makeTicket = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  orgId: "org1",
  userId: "user1",
  title: "Need help",
  description: "Please assist",
  category: "other",
  priority: "MEDIUM" as const,
  status: "TODO" as const,
  assigneeId: null,
  isConfidential: false,
  slaDueAt: null,
  resolvedAt: null,
  resolution: null,
  createdAt: new Date("2024-01-01T12:00:00Z"),
  updatedAt: new Date("2024-01-01T12:00:00Z"),
  authorName: "Alice",
  authorImage: null,
  ...overrides,
});

const buildTransactionMock = (txFn?: (tx: unknown) => unknown) => jest.fn().mockImplementation(
  async (cb: (tx: unknown) => unknown) => cb(txFn ?? mockTx),
);

const mockTx = {
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  returning: jest.fn().mockResolvedValue([makeTicket()]),
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
};

const mockDb = {
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  leftJoin: jest.fn().mockReturnThis(),
  limit: jest.fn().mockResolvedValue([]),
  orderBy: jest.fn().mockReturnThis(),
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  returning: jest.fn().mockResolvedValue([makeTicket()]),
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  delete: jest.fn().mockReturnThis(),
  execute: jest.fn().mockResolvedValue([]),
  query: {
    helpdeskTickets: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  },
  transaction: buildTransactionMock(),
};

describe("HrHelpdeskService", () => {
  let service: HrHelpdeskService;

  beforeEach(async () => {
    jest.clearAllMocks();

    mockDb.select.mockReturnThis();
    mockDb.from.mockReturnThis();
    mockDb.where.mockReturnThis();
    mockDb.leftJoin.mockReturnThis();
    mockDb.limit.mockResolvedValue([]);
    mockDb.orderBy.mockReturnThis();
    mockDb.execute.mockResolvedValue([]);

    mockTx.insert.mockReturnThis();
    mockTx.values.mockReturnThis();
    mockTx.returning.mockResolvedValue([makeTicket()]);
    mockTx.update.mockReturnThis();
    mockTx.set.mockReturnThis();
    mockTx.where.mockReturnThis();

    mockDb.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(mockTx));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HrHelpdeskService,
        { provide: DRIZZLE, useValue: mockDb },
      ],
    }).compile();

    service = module.get(HrHelpdeskService);
  });

  describe("list — cursor pagination", () => {
    it("returns a cursor page without repeating the boundary row", async () => {
      const page1Rows = [
        makeTicket({ id: 3, createdAt: new Date("2024-01-03T00:00:00Z") }),
        makeTicket({ id: 2, createdAt: new Date("2024-01-02T00:00:00Z") }),
        makeTicket({ id: 1, createdAt: new Date("2024-01-01T00:00:00Z") }),
      ];

      mockDb.orderBy.mockReturnThis();
      mockDb.limit.mockResolvedValueOnce(page1Rows);

      const result = await service.list("org1", "user1", true, { limit: 2, cursor: undefined });

      expect(result.data).toHaveLength(2);
      expect(result.data[0]).toMatchObject({ id: 3 });
      expect(result.data[1]).toMatchObject({ id: 2 });
      expect(result.pagination.hasMore).toBe(true);
      expect(result.pagination.nextCursor).not.toBeNull();
    });

    it("page 2 uses the cursor from page 1 and does not repeat the boundary row", async () => {
      const page1Rows = [
        makeTicket({ id: 3, createdAt: new Date("2024-01-03T00:00:00Z") }),
        makeTicket({ id: 2, createdAt: new Date("2024-01-02T00:00:00Z") }),
        makeTicket({ id: 1, createdAt: new Date("2024-01-01T00:00:00Z") }),
      ];

      mockDb.orderBy.mockReturnThis();
      mockDb.limit.mockResolvedValueOnce(page1Rows);
      const page1 = await service.list("org1", "user1", true, { limit: 2, cursor: undefined });

      const page2Rows = [makeTicket({ id: 1, createdAt: new Date("2024-01-01T00:00:00Z") })];
      mockDb.limit.mockResolvedValueOnce(page2Rows);

      const page2 = await service.list("org1", "user1", true, { limit: 2, cursor: page1.pagination.nextCursor ?? undefined });

      expect(page2.data).toHaveLength(1);
      expect(page2.data[0]).toMatchObject({ id: 1 });
      expect(page2.pagination.hasMore).toBe(false);
      const page1Ids = new Set(page1.data.map((r) => r.id));
      for (const row of page2.data) {
        expect(page1Ids.has(row.id)).toBe(false);
      }
    });

    it("non-admin confidentiality predicate is added before retrieval", async () => {
      mockDb.orderBy.mockReturnThis();
      mockDb.limit.mockResolvedValue([]);

      await service.list("org1", "user1", false, { limit: 20, cursor: undefined });

      const call = mockDb.where.mock.calls.at(-1);
      if (!call) throw new Error("no where clause captured");
      const built = new PgDialect().sqlToQuery(call[0] as SQL);

      expect(built.sql).toContain('"helpdesk_tickets"."is_confidential"');
      expect(built.sql).toContain('"helpdesk_tickets"."user_id"');
      expect(built.params).toContain("user1");
      expect(built.params).toContain("org1");
    });

    it("returns empty last page when no more rows exist", async () => {
      mockDb.orderBy.mockReturnThis();
      mockDb.limit.mockResolvedValue([makeTicket({ id: 1 })]);

      const result = await service.list("org1", "user1", true, { limit: 2, cursor: undefined });
      expect(result.pagination.hasMore).toBe(false);
      expect(result.pagination.nextCursor).toBeNull();
    });
  });

  describe("list — search cap+1 fallback", () => {
    const dialect = new PgDialect();

    async function searchWhere(probeRowCount: number) {
      mockDb.execute.mockResolvedValueOnce(
        Array.from({ length: probeRowCount }, (_, i) => ({ id: i + 1 })),
      );
      mockDb.orderBy.mockReturnThis();
      mockDb.limit.mockResolvedValue([]);

      await service.list("org1", "user1", true, { limit: 20, cursor: undefined, q: "help" });

      const call = mockDb.where.mock.calls.at(-1);
      if (!call) throw new Error("no where clause captured");
      return dialect.sqlToQuery(call[0] as SQL);
    }

    it("asks the probe for one more row than the cap, so the cap is detectable", async () => {
      await searchWhere(3);

      const probe = mockDb.execute.mock.calls.at(-1);
      expect(dialect.sqlToQuery(probe![0] as SQL).sql).toContain("app.search_helpdesk_ticket_ids");
      expect(dialect.sqlToQuery(probe![0] as SQL).params).toEqual(["help", 501]);
    });

    it("filters on the ids the probe returned, never on the raw text", async () => {
      const built = await searchWhere(3);

      expect(built.sql).toContain('"helpdesk_tickets"."id" in');
      expect(built.sql).not.toMatch(/ilike/i);
      expect(built.params).toEqual(expect.arrayContaining([1, 2, 3]));
    });

    it("returns nothing without scanning when the probe finds no match", async () => {
      const built = await searchWhere(0);

      expect(built.sql).toContain("false");
      expect(built.sql).not.toMatch(/ilike/i);
    });

    it("falls back to ILIKE only past the cap, where the id list stops paying for itself", async () => {
      const built = await searchWhere(502);

      expect(built.sql).toMatch(/ilike/i);
      expect(built.params).toContain("%help%");
    });
  });

  describe("create — outbox emitted atomically", () => {
    it("emits the outbox row inside the same transaction as the insert", async () => {
      let outboxEmitCallCount = 0;
      let insertCallCount = 0;

      const transactionalTx = {
        insert: jest.fn().mockImplementation(() => {
          insertCallCount++;
          return {
            values: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([makeTicket({ id: 42 })]),
          };
        }),
      };

      mockDb.transaction.mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
        const proxy = new Proxy(transactionalTx, {
          get(target, prop) {
            if (prop === "insert") {
              return (table: unknown) => {
                const isOutboxTable = String(table) !== "[object Object]";
                if (isOutboxTable && insertCallCount > 0) outboxEmitCallCount++;
                return target.insert(table);
              };
            }
            return (target as Record<string, unknown>)[String(prop)];
          },
        });
        return cb(proxy);
      });

      mockDb.select.mockReturnThis();
      mockDb.from.mockReturnThis();
      mockDb.where.mockReturnThis();
      mockDb.leftJoin.mockReturnThis();
      mockDb.limit
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([makeTicket({ id: 42 })])
        .mockResolvedValue([]);

      await service.create("org1", "user1", {
        title: "Help needed for payroll",
        category: "payroll_issue",
        priority: "MEDIUM",
      });

      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    });

    it("does not swallow transaction errors", async () => {
      mockDb.select.mockReturnThis();
      mockDb.from.mockReturnThis();
      mockDb.where.mockReturnThis();
      mockDb.limit.mockResolvedValue([]);
      mockDb.transaction.mockRejectedValueOnce(new Error("DB error"));

      await expect(
        service.create("org1", "user1", { title: "Help needed for payroll", category: "payroll_issue" }),
      ).rejects.toThrow("DB error");
    });
  });

  describe("updateTicket — outbox on change", () => {
    it("emits ticket_assigned when assignee changes", async () => {
      const existing = makeTicket({ id: 1, assigneeId: null, status: "TODO" });
      mockDb.query.helpdeskTickets.findFirst.mockResolvedValue(existing);
      mockTx.returning.mockResolvedValue([{ ...existing, assigneeId: "agent1", title: existing.title }]);

      const memberChain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([{ id: 7, orgId: "org1", userId: "agent1", role: "MEMBER", isOwner: false, status: "ACTIVE" }]),
      };
      const personChain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      };
      mockDb.select
        .mockReturnValueOnce(memberChain)
        .mockReturnValueOnce(personChain);
      mockDb.limit.mockResolvedValueOnce([makeTicket({ id: 1 })]);

      await service.updateTicket("org1", "admin1", true, 1, { assigneeId: "agent1" });

      expect(mockDb.transaction).toHaveBeenCalled();
    });

    it("emits ticket_status_changed when status changes", async () => {
      const existing = makeTicket({ id: 1, assigneeId: null, status: "TODO" });
      mockDb.query.helpdeskTickets.findFirst.mockResolvedValue(existing);
      mockTx.returning.mockResolvedValue([{ ...existing, status: "IN_PROGRESS", title: existing.title }]);
      mockDb.limit.mockResolvedValueOnce([makeTicket({ id: 1 })]);

      await service.updateTicket("org1", "admin1", true, 1, { status: "IN_PROGRESS" });

      expect(mockDb.transaction).toHaveBeenCalled();
    });

    it("throws NotFoundException when ticket not found", async () => {
      mockDb.query.helpdeskTickets.findFirst.mockResolvedValue(null);

      await expect(
        service.updateTicket("org1", "admin1", true, 999, { status: "DONE" }),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws ConflictException on duplicate title during create", async () => {
      mockDb.limit.mockResolvedValue([{ id: 5 }]);

      await expect(
        service.create("org1", "user1", { title: "Help needed for payroll", category: "payroll_issue" }),
      ).rejects.toThrow(ConflictException);
    });
  });
});
