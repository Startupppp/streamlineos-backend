jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: (_db: unknown, _orgId: string, fn: (tx: unknown) => unknown) => fn(_db),
}));

import { NotFoundException } from "@nestjs/common";
import { SurveyVersionService } from "./survey-version.service";
import type { Db } from "../../db/drizzle.module";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

describe("SurveyVersionService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  afterEach(() => jest.resetAllMocks());

  it("refuses to draft a version against a survey owned by a different org", async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const insert = jest.fn();
    const db = {
      query: {
        surveyVersions: { findFirst },
        surveyForms: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      insert,
    } as unknown as Db;
    const svc = new SurveyVersionService(db);

    await expect(svc.getDraftVersion(ATTACKER_ORG, 1)).rejects.toThrow(NotFoundException);

    expect(findFirst).toHaveBeenCalledTimes(1);
    const args = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(args?.where)).toContain(ATTACKER_ORG);
    expect(insert).not.toHaveBeenCalled();
  });

  it("creates the first version for a survey the org owns", async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const returning = jest.fn().mockResolvedValue([{ id: 99, orgId: OWNER_ORG, surveyId: 1, versionNumber: 1 }]);
    const values = jest.fn().mockReturnValue({ returning });
    const db = {
      query: {
        surveyVersions: { findFirst },
        surveyForms: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
      },
      insert: jest.fn().mockReturnValue({ values }),
    } as unknown as Db;
    const svc = new SurveyVersionService(db);

    const version = await svc.getDraftVersion(OWNER_ORG, 1);

    expect(version.id).toBe(99);
  });

  it("returns existing draft for the owning org without creating a new one (control — same-tenant)", async () => {
    const existingDraft = { id: 5, orgId: OWNER_ORG, surveyId: 1, versionNumber: 1, publishedAt: null };
    const findFirst = jest.fn().mockResolvedValue(existingDraft);
    const db = {
      query: { surveyVersions: { findFirst } },
    } as unknown as Db;
    const svc = new SurveyVersionService(db);

    const version = await svc.getDraftVersion(OWNER_ORG, 1);

    expect(version.id).toBe(5);
    expect(findFirst).toHaveBeenCalledTimes(1);
    const args = findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(args?.where)).toContain(OWNER_ORG);
  });
});
