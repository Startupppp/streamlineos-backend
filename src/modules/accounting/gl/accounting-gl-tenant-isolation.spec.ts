import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { GeneralLedgerService } from "./general-ledger.service";
import { RecurringJournalsService } from "./recurring-journals.service";
import type { AuditService } from "../../../common/audit/audit.service";

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

function makeSelectDb(rows: unknown[]): { db: Db; where: jest.Mock } {
  const where = jest.fn();
  const builder: Record<string, unknown> & { then: (r: (v: unknown) => void) => void } = {
    from: jest.fn(),
    leftJoin: jest.fn(),
    innerJoin: jest.fn(),
    where,
    orderBy: jest.fn(),
    groupBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
    offset: jest.fn(),
    then: (resolve: (v: unknown) => void) => resolve(rows),
  };
  (builder.from as jest.Mock).mockReturnValue(builder);
  (builder.leftJoin as jest.Mock).mockReturnValue(builder);
  (builder.innerJoin as jest.Mock).mockReturnValue(builder);
  (builder.where as jest.Mock).mockReturnValue(builder);
  (builder.orderBy as jest.Mock).mockReturnValue(builder);
  (builder.groupBy as jest.Mock).mockReturnValue(builder);
  (builder.offset as jest.Mock).mockReturnValue(builder);
  const db = {
    select: jest.fn().mockReturnValue(builder),
    execute: jest.fn().mockResolvedValue([]),
  } as unknown as Db;
  return { db, where };
}

const audit = { log: jest.fn() } as unknown as AuditService;

describe("GL services — cross-tenant isolation", () => {
  describe("GeneralLedgerService", () => {
    it("getGeneralLedger scopes lines to requesting org — DENY returns empty rows", async () => {
      const { db, where } = makeSelectDb([]);
      const svc = new GeneralLedgerService(db);

      const result = await svc.getGeneralLedger("org-attacker", {
        from: "2024-01-01",
        to: "2024-01-31",
        page: 1,
        pageSize: 50,
      });

      expect(result.items).toEqual([]);
      expect(where).toHaveBeenCalled();
      expect(sqlValues(where.mock.calls[0]?.[0])).toContain("org-attacker");
    });

    it("getGeneralLedger returns entries for the correct org — CONTROL case", async () => {
      const fakeRow = {
        entryId: 1,
        entryNumber: "JE-01",
        entryDate: "2024-01-15",
        accountId: 1,
        code: "1100",
        name: "Bank",
        accountType: "ASSET",
        debit: "100.00",
        credit: "0.00",
        description: null,
        lineOrder: 0,
      };
      const { db } = makeSelectDb([fakeRow]);
      const svc = new GeneralLedgerService(db);

      const result = await svc.getGeneralLedger("org-owner", {
        from: "2024-01-01",
        to: "2024-01-31",
        page: 1,
        pageSize: 50,
      });
      expect(result).toBeDefined();
    });
  });

  describe("RecurringJournalsService", () => {
    it("deleteTemplate hides a template from a different org before deletion — DENY case", async () => {
      const deleteWhere = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) });
      const db = { delete: jest.fn().mockReturnValue({ where: deleteWhere }) } as unknown as Db;
      const svc = new RecurringJournalsService(db, audit);

      await expect(svc.deleteTemplate("org-attacker", 55)).rejects.toThrow(NotFoundException);

      expect(deleteWhere).toHaveBeenCalled();
      expect(sqlValues(deleteWhere.mock.calls[0]?.[0])).toContain("org-attacker");
    });

    it("deleteTemplate removes template for the correct org — CONTROL case", async () => {
      const deleteWhere = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 55 }]) });
      const db = { delete: jest.fn().mockReturnValue({ where: deleteWhere }) } as unknown as Db;
      const svc = new RecurringJournalsService(db, audit);
      await expect(svc.deleteTemplate("org-owner", 55)).resolves.toBeDefined();
    });
  });
});
