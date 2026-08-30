import { NotFoundException } from "@nestjs/common";
import { SurveyAssessmentService } from "./survey-assessment.service";
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

describe("SurveyAssessmentService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  afterEach(() => jest.resetAllMocks());

  it("returns empty attempts for a different org (deny: isolation)", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const db = {
      query: { surveyAssessmentAttempts: { findMany } },
    } as unknown as Db;
    const svc = new SurveyAssessmentService(db);

    const result = await svc.listAttempts(ATTACKER_ORG, 1, { page: 1, pageSize: 20 });

    expect(result).toHaveLength(0);
    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(args?.where)).toContain(ATTACKER_ORG);
  });

  it("returns attempts for the owning org (control — same-tenant)", async () => {
    const attempt = { id: 1, orgId: OWNER_ORG, surveyId: 5, status: "in_progress" };
    const findMany = jest.fn().mockResolvedValue([attempt]);
    const db = {
      query: { surveyAssessmentAttempts: { findMany } },
    } as unknown as Db;
    const svc = new SurveyAssessmentService(db);

    const result = await svc.listAttempts(OWNER_ORG, 5, { page: 1, pageSize: 20 });

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(1);
  });

  it("throws NotFoundException for a cross-tenant survey id (isolation)", async () => {
    const db = {
      query: { surveyForms: { findFirst: jest.fn().mockResolvedValue(null) } },
    } as unknown as Db;
    const svc = new SurveyAssessmentService(db);

    await expect(svc.createAttempt(ATTACKER_ORG, 99, null)).rejects.toThrow(NotFoundException);
  });
});
