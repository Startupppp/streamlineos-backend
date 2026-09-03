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

  it("refuses attempts for a survey owned by a different org (deny: isolation)", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const db = {
      query: {
        surveyForms: { findFirst: jest.fn().mockResolvedValue(undefined) },
        surveyAssessmentAttempts: { findMany },
      },
    } as unknown as Db;
    const svc = new SurveyAssessmentService(db);

    await expect(svc.listAttempts(ATTACKER_ORG, 1, { page: 1, pageSize: 20 })).rejects.toThrow(NotFoundException);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("returns attempts for the owning org (control — same-tenant)", async () => {
    const attempt = { id: 1, orgId: OWNER_ORG, surveyId: 5, status: "in_progress" };
    const findMany = jest.fn().mockResolvedValue([attempt]);
    const db = {
      query: {
        surveyForms: { findFirst: jest.fn().mockResolvedValue({ id: 5 }) },
        surveyAssessmentAttempts: { findMany },
      },
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

  describe("completeAttempt — TOCTOU write fix", () => {
    it("includes orgId in the update WHERE so the write cannot cross tenant boundaries (cross-tenant DENY)", async () => {
      const updateWhere = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) });
      const db = {
        query: {
          surveyForms: { findFirst: jest.fn().mockResolvedValue({ id: 5, orgId: ATTACKER_ORG, settings: {} }) },
          surveyAssessmentAttempts: { findFirst: jest.fn().mockResolvedValue({ id: 1, orgId: ATTACKER_ORG, sessionId: 10, participantId: null }) },
        },
        update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: updateWhere }) }),
      } as unknown as Db;
      const svc = new SurveyAssessmentService(db);

      await svc.completeAttempt(ATTACKER_ORG, 5, 10, 80);

      expect(updateWhere).toHaveBeenCalledTimes(1);
      const whereArg = updateWhere.mock.calls[0]?.[0];
      expect(sqlValues(whereArg)).toContain(ATTACKER_ORG);
      expect(sqlValues(whereArg)).not.toContain(OWNER_ORG);
    });

    it("includes orgId in the update WHERE for the owning org (same-tenant CONTROL)", async () => {
      const updateWhere = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 1, orgId: OWNER_ORG, status: "passed", score: 90, passed: true }]) });
      const db = {
        query: {
          surveyForms: { findFirst: jest.fn().mockResolvedValue({ id: 5, orgId: OWNER_ORG, settings: { passScore: 70 } }) },
          surveyAssessmentAttempts: { findFirst: jest.fn().mockResolvedValue({ id: 1, orgId: OWNER_ORG, sessionId: 10, participantId: null }) },
        },
        update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: updateWhere }) }),
      } as unknown as Db;
      const svc = new SurveyAssessmentService(db);

      const result = await svc.completeAttempt(OWNER_ORG, 5, 10, 90);

      expect(result).toMatchObject({ id: 1, status: "passed" });
      expect(updateWhere).toHaveBeenCalledTimes(1);
      const whereArg = updateWhere.mock.calls[0]?.[0];
      expect(sqlValues(whereArg)).toContain(OWNER_ORG);
    });
  });
});
