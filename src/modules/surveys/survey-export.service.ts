import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { surveyResponseSessions, surveyAnswers, surveyQuestions } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { ExportResponsesInput } from "./dto/survey-analytics.schemas";

function csvEscape(value: unknown): string {
  const str = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

@Injectable()
export class SurveyExportService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async exportResponsesCsv(orgId: string, surveyId: number, filters: ExportResponsesInput) {
    const conditions = [eq(surveyResponseSessions.orgId, orgId), eq(surveyResponseSessions.surveyId, surveyId)];
    if (filters.collectorId) conditions.push(eq(surveyResponseSessions.collectorId, filters.collectorId));
    if (filters.status) conditions.push(eq(surveyResponseSessions.status, filters.status));

    const sessions = await this.db.query.surveyResponseSessions.findMany({
      where: and(...conditions),
      orderBy: [asc(surveyResponseSessions.startedAt)],
    });

    const questions = await this.db.query.surveyQuestions.findMany({
      where: eq(surveyQuestions.surveyId, surveyId),
      orderBy: [asc(surveyQuestions.sortOrder)],
    });
    const questionIds = [...new Set(questions.map((q) => q.id))];
    const questionTitleById = new Map(questions.map((q) => [q.id, q.title]));

    const header = ["session_id", "status", "started_at", "submitted_at", "score", "passed", ...questionIds.map((id) => csvEscape(questionTitleById.get(id)))];
    const rows: string[] = [header.join(",")];

    for (const session of sessions) {
      const answers = await this.db.query.surveyAnswers.findMany({ where: eq(surveyAnswers.sessionId, session.id) });
      const answerByQuestion = new Map(answers.map((a) => [a.questionId, a]));

      const row = [
        session.id,
        session.status,
        session.startedAt?.toISOString() ?? "",
        session.submittedAt?.toISOString() ?? "",
        session.score ?? "",
        session.passed ?? "",
        ...questionIds.map((id) => {
          const answer = answerByQuestion.get(id);
          if (!answer) return "";
          return csvEscape(answer.answerText ?? (answer.answerValue !== null ? JSON.stringify(answer.answerValue) : ""));
        }),
      ];
      rows.push(row.map(csvEscape).join(","));
    }

    return rows.join("\n");
  }
}
