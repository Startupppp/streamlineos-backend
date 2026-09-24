import { SurveyAnalyticsService } from "./survey-analytics.service";
import { ANONYMITY_MIN_RESPONSES } from "../../common/privacy/anonymity-threshold";
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

const ORG = "org-owner";
const CHOICE_QUESTION = {
  id: 10,
  orgId: ORG,
  type: "single_choice",
  title: "How was onboarding?",
  choices: [
    { id: 100, label: "Great" },
    { id: 101, label: "Poor" },
  ],
};
const TEXT_QUESTION = { id: 11, orgId: ORG, type: "long_text", title: "Anything else?", choices: [] };

function makeDb(anonymousSubmitted: number, answers: unknown[]) {
  const where = jest.fn().mockResolvedValue([{ total: anonymousSubmitted }]);
  return {
    db: {
      query: {
        surveyQuestions: { findMany: jest.fn().mockResolvedValue([CHOICE_QUESTION, TEXT_QUESTION]) },
        surveyAnswers: { findMany: jest.fn().mockResolvedValue(answers) },
      },
      select: () => ({ from: () => ({ where }) }),
    } as unknown as Db,
    where,
  };
}

const ANSWERS = [
  { questionId: 10, choiceIds: [100], answerValue: null, answerText: null },
  { questionId: 10, choiceIds: [101], answerValue: null, answerText: null },
  { questionId: 11, choiceIds: null, answerValue: null, answerText: "I felt singled out" },
];

describe("SurveyAnalyticsService.questionAnalytics — anonymity threshold", () => {
  it("hides every breakdown, including free text, when one fewer anonymous response than the minimum was submitted", async () => {
    const { db } = makeDb(ANONYMITY_MIN_RESPONSES - 1, ANSWERS);

    const result = await new SurveyAnalyticsService(db).questionAnalytics(ORG, 1, 1);

    expect(result.map((q) => q.suppressed)).toEqual([true, true]);
    expect(result[0]).toMatchObject({ responseCount: 2, average: null, choiceDistribution: [], minResponses: ANONYMITY_MIN_RESPONSES });
    expect(result[1]?.textResponses).toBeUndefined();
  });

  it("shows the breakdown once the anonymous responses reach the minimum", async () => {
    const { db } = makeDb(ANONYMITY_MIN_RESPONSES, ANSWERS);

    const result = await new SurveyAnalyticsService(db).questionAnalytics(ORG, 1, 1);

    expect(result.map((q) => q.suppressed)).toEqual([false, false]);
    expect(result[0]?.choiceDistribution).toEqual([
      { choiceId: 100, label: "Great", count: 1 },
      { choiceId: 101, label: "Poor", count: 1 },
    ]);
    expect(result[1]?.textResponses).toEqual(["I felt singled out"]);
  });

  it("does not suppress a survey whose responses were all identified — there is no anonymity to protect", async () => {
    const { db } = makeDb(0, ANSWERS);

    const result = await new SurveyAnalyticsService(db).questionAnalytics(ORG, 1, 1);

    expect(result.map((q) => q.suppressed)).toEqual([false, false]);
  });

  it("counts anonymous responses inside the caller's own organisation and survey, never across tenants", async () => {
    const { db, where } = makeDb(ANONYMITY_MIN_RESPONSES, ANSWERS);

    await new SurveyAnalyticsService(db).questionAnalytics(ORG, 42, 1);

    const predicate = sqlValues(where.mock.calls[0]?.[0]);
    expect(predicate).toContain(ORG);
    expect(predicate).toContain(42);
  });
});
