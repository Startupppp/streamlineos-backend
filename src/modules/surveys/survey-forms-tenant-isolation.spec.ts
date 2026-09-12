import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { ScopedRead } from "../access/scoped-read";
import { SurveyFormsService } from "./survey-forms.service";

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

const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";

/**
 * `select({ total }).from(t).where(p)` — the COUNT half of the list envelope.
 *
 * It is a second read of the same table, so it is held to the same tenant predicate as the
 * page read: a count that escaped the org scope would disclose another tenant's row count.
 */
function countSelect(total: number) {
  const countWhere = jest.fn();
  const chain: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown) => Promise.resolve([{ total }]).then(resolve),
  };
  chain["from"] = jest.fn().mockReturnValue(chain);
  chain["where"] = countWhere.mockReturnValue(chain);
  return { select: jest.fn().mockReturnValue(chain), countWhere };
}

// The controller resolves the caller's scope; the service is handed the ScopedRead.
const readAll = (orgId: string) => ScopedRead.of(orgId, "user-1", "all");

const mockVersions = {} as never;
const mockTemplates = { get: jest.fn().mockReturnValue(undefined) } as never;
const mockPlanLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) } as never;

describe("SurveyFormsService — cross-tenant isolation", () => {
  describe("list", () => {
    it("returns empty list for a different org (cross-tenant DENY)", async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const { select, countWhere } = countSelect(0);
      const db = {
        query: { surveyForms: { findMany } },
        select,
      } as unknown as Db;
      const svc = new SurveyFormsService(db, mockVersions, mockTemplates, mockPlanLimits);

      const result = await svc.list({ page: 1, pageSize: 20 }, readAll(ATTACKER_ORG));

      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(findMany).toHaveBeenCalledTimes(1);
      const callArg = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(callArg?.where)).toContain(ATTACKER_ORG);
      expect(sqlValues(countWhere.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
    });

    it("returns surveys scoped to the owning org (same-tenant CONTROL)", async () => {
      const row = { id: 10, orgId: OWNER_ORG, title: "Onboarding Survey" };
      const findMany = jest.fn().mockResolvedValue([row]);
      const { select, countWhere } = countSelect(1);
      const db = {
        query: { surveyForms: { findMany } },
        select,
      } as unknown as Db;
      const svc = new SurveyFormsService(db, mockVersions, mockTemplates, mockPlanLimits);

      const result = await svc.list({ page: 1, pageSize: 20 }, readAll(OWNER_ORG));

      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(sqlValues(countWhere.mock.calls[0]?.[0])).toContain(OWNER_ORG);
    });
  });

  describe("get", () => {
    it("throws NotFoundException when survey belongs to a different org (cross-tenant DENY)", async () => {
      const findFirst = jest.fn().mockResolvedValue(undefined);
      const db = {
        query: { surveyForms: { findFirst } },
      } as unknown as Db;
      const svc = new SurveyFormsService(db, mockVersions, mockTemplates, mockPlanLimits);

      await expect(svc.get(10, readAll(ATTACKER_ORG))).rejects.toThrow(NotFoundException);

      expect(findFirst).toHaveBeenCalledTimes(1);
      const callArg = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(callArg?.where)).toContain(ATTACKER_ORG);
    });

    it("returns survey for the owning org (same-tenant CONTROL)", async () => {
      const row = { id: 10, orgId: OWNER_ORG, title: "Onboarding Survey" };
      const findFirst = jest.fn().mockResolvedValue(row);
      const db = {
        query: { surveyForms: { findFirst } },
      } as unknown as Db;
      const svc = new SurveyFormsService(db, mockVersions, mockTemplates, mockPlanLimits);

      const result = await svc.get(10, readAll(OWNER_ORG));

      expect(result).toMatchObject({ id: 10 });
    });
  });
});
