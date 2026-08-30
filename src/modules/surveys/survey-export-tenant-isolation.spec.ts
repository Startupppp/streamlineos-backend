import { SurveyExportService } from "./survey-export.service";
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

describe("SurveyExportService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  afterEach(() => jest.resetAllMocks());

  it("exports only the header row for a different org (deny: isolation)", async () => {
    const sessionsFindMany = jest.fn().mockResolvedValue([]);
    const questionsFindMany = jest.fn().mockResolvedValue([]);
    const db = {
      query: {
        surveyResponseSessions: { findMany: sessionsFindMany },
        surveyQuestions: { findMany: questionsFindMany },
      },
    } as unknown as Db;
    const svc = new SurveyExportService(db);

    const csv = await svc.exportResponsesCsv(ATTACKER_ORG, 1, {});

    const lines = csv.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(sessionsFindMany).toHaveBeenCalledTimes(1);
    const args = sessionsFindMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(args?.where)).toContain(ATTACKER_ORG);
  });

  it("exports data rows for the owning org (control — same-tenant)", async () => {
    const session = {
      id: 1,
      status: "submitted",
      startedAt: new Date("2024-01-01"),
      submittedAt: new Date("2024-01-01"),
      score: null,
      passed: null,
    };
    const sessionsFindMany = jest.fn().mockResolvedValue([session]);
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

    const csv = await svc.exportResponsesCsv(OWNER_ORG, 1, {});

    const lines = csv.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(1);
  });
});
