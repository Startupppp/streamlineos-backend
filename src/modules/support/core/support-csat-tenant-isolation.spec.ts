import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { SupportCsatService } from "./support-csat.service";

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

function makeDb(rows: unknown[]): { db: Db; findFirst: jest.Mock } {
  const findFirst = jest.fn().mockResolvedValue(rows[0] ?? undefined);
  const db = {
    query: {
      supportTickets: { findFirst },
      supportCsatRequests: { findFirst: jest.fn().mockResolvedValue(undefined), findMany: jest.fn().mockResolvedValue([]) },
      csatSurveys: { findMany: jest.fn().mockResolvedValue([]) },
      csatResponses: { findMany: jest.fn().mockResolvedValue([]) },
    },
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    onConflictDoNothing: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue([]),
  } as unknown as Db;
  return { db, findFirst };
}

describe("SupportCsatService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  describe("createRequestForTicket", () => {
    it("throws NotFoundException when ticket belongs to a different org (cross-tenant DENY)", async () => {
      const { db, findFirst } = makeDb([]);
      findFirst.mockResolvedValue(undefined);
      const svc = new SupportCsatService(db);

      await expect(svc.createRequestForTicket(ATTACKER_ORG, 42)).rejects.toThrow(NotFoundException);

      expect(findFirst).toHaveBeenCalledTimes(1);
      const callArg = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(callArg?.where)).toContain(ATTACKER_ORG);
    });

    it("succeeds for the owning org when ticket exists (same-tenant CONTROL)", async () => {
      const { db, findFirst } = makeDb([{ id: 42, orgId: OWNER_ORG }]);
      findFirst.mockResolvedValue({ id: 42, orgId: OWNER_ORG });
      const svc = new SupportCsatService(db);

      await expect(svc.createRequestForTicket(OWNER_ORG, 42)).resolves.not.toThrow();

      expect(findFirst).toHaveBeenCalledTimes(1);
      const callArg = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(callArg?.where)).toContain(OWNER_ORG);
    });
  });

  describe("getReport", () => {
    it("returns only data scoped to the attacker org (cross-tenant isolation — empty)", async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const db = {
        query: {
          supportCsatRequests: { findMany },
          csatSurveys: { findMany: jest.fn().mockResolvedValue([]) },
        },
        select: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue([]),
      } as unknown as Db;
      const svc = new SupportCsatService(db);

      const result = await svc.getReport(ATTACKER_ORG);

      expect(result.totalRequests).toBe(0);
      expect(findMany).toHaveBeenCalledTimes(1);
      const callArg = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(callArg?.where)).toContain(ATTACKER_ORG);
    });

    it("returns actual data for the owning org (same-tenant CONTROL)", async () => {
      const rows = [{ score: 5, respondedAt: new Date() }, { score: null, respondedAt: null }];
      const findMany = jest.fn().mockResolvedValue(rows);
      const db = {
        query: {
          supportCsatRequests: { findMany },
          csatSurveys: { findMany: jest.fn().mockResolvedValue([]) },
        },
        select: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue([]),
      } as unknown as Db;
      const svc = new SupportCsatService(db);

      const result = await svc.getReport(OWNER_ORG);

      expect(result.totalRequests).toBe(2);
      expect(result.totalResponses).toBe(1);
    });
  });
});
