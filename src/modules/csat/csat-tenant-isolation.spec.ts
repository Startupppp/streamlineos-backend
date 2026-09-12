import { type Db } from "../../db/drizzle.module";
import { CsatService } from "./csat.service";

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

describe("CsatService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  describe("listSurveys", () => {
    it("returns empty list for a different org (cross-tenant DENY)", async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const db = {
        query: { csatSurveys: { findMany } },
      } as unknown as Db;
      const svc = new CsatService(db);

      const result = await svc.listSurveys(ATTACKER_ORG);

      expect(result).toHaveLength(0);
      expect(findMany).toHaveBeenCalledTimes(1);
      const callArg = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(callArg?.where)).toContain(ATTACKER_ORG);
    });

    it("returns surveys for the owning org (same-tenant CONTROL)", async () => {
      const survey = { id: 1, orgId: OWNER_ORG, title: "Q1 CSAT", responses: [{ rating: 4 }] };
      const findMany = jest.fn().mockResolvedValue([survey]);
      const db = {
        query: { csatSurveys: { findMany } },
      } as unknown as Db;
      const svc = new CsatService(db);

      const result = await svc.listSurveys(OWNER_ORG);

      expect(result).toHaveLength(1);
      expect(result[0]?.responseCount).toBe(1);
    });
  });

  describe("getSurvey", () => {
    it("returns null when survey belongs to a different org (cross-tenant DENY)", async () => {
      const findFirst = jest.fn().mockResolvedValue(undefined);
      const db = {
        query: { csatSurveys: { findFirst } },
      } as unknown as Db;
      const svc = new CsatService(db);

      const result = await svc.getSurvey(ATTACKER_ORG, 99);

      // `null`, not the driver's `undefined`, since the client's name began
      // coming from Party (aca3b37fd): a miss returns before that read, and the
      // controller 404s on either. The claim is unchanged -- the lookup is
      // org-scoped, so another tenant's survey is simply not found.
      expect(result).toBeNull();
      expect(findFirst).toHaveBeenCalledTimes(1);
      const callArg = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(callArg?.where)).toContain(ATTACKER_ORG);
    });

    it("returns the survey for the owning org (same-tenant CONTROL)", async () => {
      const survey = { id: 99, orgId: OWNER_ORG, title: "Satisfaction Survey", responses: [] };
      const findFirst = jest.fn().mockResolvedValue(survey);
      const db = {
        query: { csatSurveys: { findFirst } },
      } as unknown as Db;
      const svc = new CsatService(db);

      const result = await svc.getSurvey(OWNER_ORG, 99);

      expect(result).toMatchObject({ id: 99 });
    });
  });

  describe("deleteSurvey", () => {
    it("includes orgId in delete WHERE so cross-tenant survey is not deleted (cross-tenant DENY)", async () => {
      const deleteWhere = jest.fn().mockResolvedValue([]);
      const db = {
        query: { csatSurveys: { findFirst: jest.fn().mockResolvedValue({ id: 99 }) } },
        delete: jest.fn().mockReturnValue({ where: deleteWhere }),
      } as unknown as Db;
      const svc = new CsatService(db);

      await svc.deleteSurvey(ATTACKER_ORG, 99);

      expect(deleteWhere).toHaveBeenCalledTimes(1);
      const whereArg = deleteWhere.mock.calls[0]?.[0];
      expect(sqlValues(whereArg)).toContain(ATTACKER_ORG);
      expect(sqlValues(whereArg)).not.toContain(OWNER_ORG);
    });

    it("includes orgId in delete WHERE for the owning org (same-tenant CONTROL)", async () => {
      const deleteWhere = jest.fn().mockResolvedValue([]);
      const db = {
        query: { csatSurveys: { findFirst: jest.fn().mockResolvedValue({ id: 99 }) } },
        delete: jest.fn().mockReturnValue({ where: deleteWhere }),
      } as unknown as Db;
      const svc = new CsatService(db);

      const result = await svc.deleteSurvey(OWNER_ORG, 99);

      expect(result).toHaveProperty("success", true);
      const whereArg = deleteWhere.mock.calls[0]?.[0];
      expect(sqlValues(whereArg)).toContain(OWNER_ORG);
    });
  });

  describe("listResponses", () => {
    it("returns null (survey not found) when survey belongs to a different org (cross-tenant DENY)", async () => {
      const findFirst = jest.fn().mockResolvedValue(undefined);
      const db = {
        query: {
          csatSurveys: { findFirst },
          csatResponses: { findMany: jest.fn().mockResolvedValue([]) },
        },
      } as unknown as Db;
      const svc = new CsatService(db);

      const result = await svc.listResponses(ATTACKER_ORG, 99, 50);

      expect(result).toBeNull();
      const callArg = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(callArg?.where)).toContain(ATTACKER_ORG);
    });

    it("returns responses for the owning org (same-tenant CONTROL)", async () => {
      const findFirst = jest.fn().mockResolvedValue({ id: 99 });
      const findMany = jest.fn().mockResolvedValue([{ id: 1, rating: 5 }]);
      const db = {
        query: {
          csatSurveys: { findFirst },
          csatResponses: { findMany },
        },
      } as unknown as Db;
      const svc = new CsatService(db);

      const result = await svc.listResponses(OWNER_ORG, 99, 50);

      expect(result).toHaveLength(1);
    });
  });
});
