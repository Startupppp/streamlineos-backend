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
    it("returns undefined when survey belongs to a different org (cross-tenant DENY)", async () => {
      const findFirst = jest.fn().mockResolvedValue(undefined);
      const db = {
        query: { csatSurveys: { findFirst } },
      } as unknown as Db;
      const svc = new CsatService(db);

      const result = await svc.getSurvey(ATTACKER_ORG, 99);

      expect(result).toBeUndefined();
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
