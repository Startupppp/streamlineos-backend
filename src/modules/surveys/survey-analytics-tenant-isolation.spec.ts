import { SurveyAnalyticsService } from "./survey-analytics.service";
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

describe("SurveyAnalyticsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  afterEach(() => jest.resetAllMocks());

  it("returns empty result for a different org (deny: isolation)", async () => {
    const questionsFindMany = jest.fn().mockResolvedValue([]);
    const db = {
      query: {
        surveyQuestions: { findMany: questionsFindMany },
        surveyAnswers: { findMany: jest.fn().mockResolvedValue([]) },
      },
    } as unknown as Db;
    const svc = new SurveyAnalyticsService(db);

    const result = await svc.questionAnalytics(ATTACKER_ORG, 1, 1);

    expect(result).toHaveLength(0);
    expect(questionsFindMany).toHaveBeenCalledTimes(1);
    const args = questionsFindMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(args?.where)).toContain(ATTACKER_ORG);
  });

  it("returns data for the owning org (control — same-tenant)", async () => {
    const question = { id: 10, orgId: OWNER_ORG, type: "short_text", title: "Q1", choices: [] };
    const questionsFindMany = jest.fn().mockResolvedValue([question]);
    const answersFindMany = jest.fn().mockResolvedValue([]);
    const db = {
      query: {
        surveyQuestions: { findMany: questionsFindMany },
        surveyAnswers: { findMany: answersFindMany },
      },
    } as unknown as Db;
    const svc = new SurveyAnalyticsService(db);

    const result = await svc.questionAnalytics(OWNER_ORG, 1, 1);

    expect(result).toHaveLength(1);
    expect(result[0]?.questionId).toBe(10);
  });
});
