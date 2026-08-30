import { SurveyAnalyticsService } from "./survey-analytics.service";
import type { Db } from "../../db/drizzle.module";

describe("SurveyAnalyticsService — answers cap", () => {
  afterEach(() => jest.resetAllMocks());

  it("applies SURVEY_ANALYTICS_ANSWERS_CAP limit to the answers query", async () => {
    const question = { id: 1, type: "text", title: "Q1", choices: [] };
    const questionsFindMany = jest.fn().mockResolvedValue([question]);
    const answersFindMany = jest.fn().mockResolvedValue([]);
    const db = {
      query: {
        surveyQuestions: { findMany: questionsFindMany },
        surveyAnswers: { findMany: answersFindMany },
      },
    } as unknown as Db;
    const svc = new SurveyAnalyticsService(db);

    await svc.questionAnalytics("org-1", 1, 1);

    expect(answersFindMany).toHaveBeenCalledTimes(1);
    const args = answersFindMany.mock.calls[0]?.[0] as { limit?: number } | undefined;
    expect(typeof args?.limit).toBe("number");
    expect(args!.limit).toBeGreaterThan(0);
    expect(args!.limit).toBeLessThanOrEqual(100_000);
  });

  it("skips the answers query when no questions exist", async () => {
    const questionsFindMany = jest.fn().mockResolvedValue([]);
    const answersFindMany = jest.fn();
    const db = {
      query: {
        surveyQuestions: { findMany: questionsFindMany },
        surveyAnswers: { findMany: answersFindMany },
      },
    } as unknown as Db;
    const svc = new SurveyAnalyticsService(db);

    const result = await svc.questionAnalytics("org-1", 1, 1);

    expect(result).toEqual([]);
    expect(answersFindMany).not.toHaveBeenCalled();
  });
});
