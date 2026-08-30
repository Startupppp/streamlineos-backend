import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { JournalApprovalsService } from "./journal-approvals.service";
import { PeriodsService } from "./periods.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CacheService } from "../../../common/cache/cache.service";
import type { NotificationDispatchService } from "../../notifications/notification-dispatch.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

type SelectBuilder = {
  from: jest.Mock;
  where: jest.Mock;
  limit: jest.Mock;
};

function makeSelectDb(rows: unknown[]): { db: Db; builder: SelectBuilder } {
  const builder: SelectBuilder = {
    from: jest.fn(),
    where: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  builder.from.mockReturnValue(builder);
  builder.where.mockReturnValue(builder);
  const db = { select: jest.fn().mockReturnValue(builder) } as unknown as Db;
  return { db, builder };
}

const dispatch = { emit: jest.fn() } as unknown as NotificationDispatchService;
const audit = { log: jest.fn() } as unknown as AuditService;
const cache = { cached: jest.fn(), invalidate: jest.fn() } as unknown as CacheService;

describe("GL — cross-tenant isolation", () => {
  describe("JournalApprovalsService", () => {
    it("hides a journal entry from a different org before any approval action — DENY case", async () => {
      const { db, builder } = makeSelectDb([]);
      const svc = new JournalApprovalsService(db, dispatch);

      await expect(svc.submitForApproval("org-attacker", "user-x", 99)).rejects.toThrow(
        NotFoundException,
      );

      expect(builder.where).toHaveBeenCalled();
      expect(sqlValues(builder.where.mock.calls[0]?.[0])).toContain("org-attacker");
    });

    it("returns the entry when the caller's org matches — CONTROL case", async () => {
      const entry = {
        id: 99,
        orgId: "org-owner",
        status: "DRAFT",
        createdBy: "user-x",
        entryNumber: "JE-01",
        entryDate: "2024-01-01",
        description: "Test",
        sourceType: "manual",
        sourceId: null,
        sourceEvent: null,
        currency: "INR",
        periodId: null,
        postingDate: null,
        approvedBy: null,
        approvedAt: null,
        postedBy: null,
        postedAt: null,
        reversedEntryId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const { db: db1 } = makeSelectDb([entry]);

      const pendingBuilder: SelectBuilder = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      };
      const txMock = {
        update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
        select: jest.fn().mockReturnValue(pendingBuilder),
      };
      const dbWithTx = {
        ...db1,
        select: jest.fn()
          .mockReturnValueOnce({ from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([entry]) }) }) })
          .mockReturnValue(pendingBuilder),
        transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => cb(txMock)),
      } as unknown as Db;

      const svc = new JournalApprovalsService(dbWithTx, dispatch);
      await expect(svc.submitForApproval("org-owner", "user-x", 99)).resolves.not.toThrow();
    });
  });

  describe("PeriodsService", () => {
    it("hides a period from a different org before closing — DENY case", async () => {
      const { db, builder } = makeSelectDb([]);
      const svc = new PeriodsService(db, cache, audit, dispatch);

      await expect(svc.closePeriod("org-attacker", "user-x", 77)).rejects.toThrow(NotFoundException);

      expect(builder.where).toHaveBeenCalled();
      expect(sqlValues(builder.where.mock.calls[0]?.[0])).toContain("org-attacker");
    });

    it("closes a period when the caller's org matches — CONTROL case", async () => {
      const period = { id: 77, orgId: "org-owner", status: "OPEN", name: "Jan 2024" };
      const updatedPeriod = { ...period, status: "CLOSED", closedByMembershipId: 1, closedAt: new Date() };

      const db = {
        select: jest.fn()
          .mockReturnValueOnce({ from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([period]) }) }) })
          .mockReturnValueOnce({ from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([{ id: 1 }]) }) }) }),
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([updatedPeriod]) }),
          }),
        }),
      } as unknown as Db;

      const svc = new PeriodsService(db, cache, audit, dispatch);
      const result = await svc.closePeriod("org-owner", "user-x", 77);

      expect(result).toBeDefined();
    });
  });
});
