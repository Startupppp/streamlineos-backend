import { SurveyExportService } from "./survey-export.service";
import type { Db } from "../../db/drizzle.module";

describe("SurveyExportService — export cap", () => {
  afterEach(() => jest.resetAllMocks());

  it("applies SURVEY_EXPORT_CAP limit to the sessions query", async () => {
    const sessionsFindMany = jest.fn().mockResolvedValue([]);
    const questionsFindMany = jest.fn().mockResolvedValue([]);
    const db = {
      query: {
        surveyResponseSessions: { findMany: sessionsFindMany },
        surveyQuestions: { findMany: questionsFindMany },
      },
    } as unknown as Db;
    const svc = new SurveyExportService(db);

    await svc.exportResponsesCsv("org-1", 1, { format: "csv" });

    expect(sessionsFindMany).toHaveBeenCalledTimes(1);
    const args = sessionsFindMany.mock.calls[0]?.[0] as { limit?: number } | undefined;
    expect(typeof args?.limit).toBe("number");
    expect(args!.limit).toBeGreaterThan(0);
    expect(args!.limit).toBeLessThanOrEqual(10_000);
  });

  it("truncated is false when fewer than cap rows returned", async () => {
    const sessionsFindMany = jest.fn().mockResolvedValue([{ id: 1, status: "submitted", startedAt: null, submittedAt: null, score: null, passed: null }]);
    const questionsFindMany = jest.fn().mockResolvedValue([]);
    const answersFindMany = jest.fn().mockResolvedValue([]);
    const db = {
      query: {
        surveyResponseSessions: { findMany: sessionsFindMany },
        surveyQuestions: { findMany: questionsFindMany },
        surveyAnswers: { findMany: answersFindMany },
      },
    } as unknown as Db;
    const svc = new SurveyExportService(db);

    const result = await svc.exportResponsesCsv("org-1", 1, { format: "csv" });

    expect(result.truncated).toBe(false);
    expect(result.rowCount).toBe(1);
  });

  it("truncated is true when exactly cap rows are returned", async () => {
    const cap = 5_000;
    const sessions = Array.from({ length: cap }, (_, i) => ({ id: i + 1, status: "submitted", startedAt: null, submittedAt: null, score: null, passed: null }));
    const sessionsFindMany = jest.fn().mockResolvedValue(sessions);
    const questionsFindMany = jest.fn().mockResolvedValue([]);
    const answersFindMany = jest.fn().mockResolvedValue([]);
    const db = {
      query: {
        surveyResponseSessions: { findMany: sessionsFindMany },
        surveyQuestions: { findMany: questionsFindMany },
        surveyAnswers: { findMany: answersFindMany },
      },
    } as unknown as Db;
    const svc = new SurveyExportService(db);

    const result = await svc.exportResponsesCsv("org-1", 1, { format: "csv" });

    expect(result.truncated).toBe(true);
    expect(result.rowCount).toBe(cap);
  });
});
