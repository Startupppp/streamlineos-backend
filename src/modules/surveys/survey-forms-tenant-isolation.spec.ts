import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
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

const mockVersions = {} as never;
const mockTemplates = { get: jest.fn().mockReturnValue(undefined) } as never;
const mockPlanLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) } as never;

describe("SurveyFormsService — cross-tenant isolation", () => {
  describe("list", () => {
    it("returns empty list for a different org (cross-tenant DENY)", async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const db = {
        query: { surveyForms: { findMany } },
      } as unknown as Db;
      const svc = new SurveyFormsService(db, mockVersions, mockTemplates, mockPlanLimits);

      const result = await svc.list(ATTACKER_ORG, { page: 1, pageSize: 20 });

      expect(result).toHaveLength(0);
      expect(findMany).toHaveBeenCalledTimes(1);
      const callArg = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
      expect(sqlValues(callArg?.where)).toContain(ATTACKER_ORG);
    });

    it("returns surveys scoped to the owning org (same-tenant CONTROL)", async () => {
      const row = { id: 10, orgId: OWNER_ORG, title: "Onboarding Survey" };
      const findMany = jest.fn().mockResolvedValue([row]);
      const db = {
        query: { surveyForms: { findMany } },
      } as unknown as Db;
      const svc = new SurveyFormsService(db, mockVersions, mockTemplates, mockPlanLimits);

      const result = await svc.list(OWNER_ORG, { page: 1, pageSize: 20 });

      expect(result).toHaveLength(1);
    });
  });

  describe("get", () => {
    it("throws NotFoundException when survey belongs to a different org (cross-tenant DENY)", async () => {
      const findFirst = jest.fn().mockResolvedValue(undefined);
      const db = {
        query: { surveyForms: { findFirst } },
      } as unknown as Db;
      const svc = new SurveyFormsService(db, mockVersions, mockTemplates, mockPlanLimits);

      await expect(svc.get(ATTACKER_ORG, 10)).rejects.toThrow(NotFoundException);

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

      const result = await svc.get(OWNER_ORG, 10);

      expect(result).toMatchObject({ id: 10 });
    });
  });
});
