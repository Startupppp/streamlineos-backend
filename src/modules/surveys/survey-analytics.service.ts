import { Inject, Injectable } from "@nestjs/common";
import { and, avg, count, eq } from "drizzle-orm";
import {
  surveyResponseSessions,
  surveyAnswers,
  surveyQuestions,
  surveyQuestionChoices,
  surveyParticipants,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";

@Injectable()
export class SurveyAnalyticsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async overview(orgId: string, surveyId: number) {
    const [totals] = await this.db
      .select({ total: count() })
      .from(surveyResponseSessions)
      .where(and(eq(surveyResponseSessions.orgId, orgId), eq(surveyResponseSessions.surveyId, surveyId)));

    const [submitted] = await this.db
      .select({ total: count(), avgDuration: avg(surveyResponseSessions.durationSeconds), avgScore: avg(surveyResponseSessions.score) })
      .from(surveyResponseSessions)
      .where(and(eq(surveyResponseSessions.orgId, orgId), eq(surveyResponseSessions.surveyId, surveyId), eq(surveyResponseSessions.status, "submitted")));

    const [participantTotals] = await this.db
      .select({ total: count() })
      .from(surveyParticipants)
      .where(and(eq(surveyParticipants.orgId, orgId), eq(surveyParticipants.surveyId, surveyId)));

    const totalResponses = totals?.total ?? 0;
    const submittedResponses = submitted?.total ?? 0;

    return {
      totalResponses,
      submittedResponses,
      completionRate: totalResponses > 0 ? submittedResponses / totalResponses : 0,
      averageCompletionTimeSeconds: submitted?.avgDuration ? Number(submitted.avgDuration) : null,
      averageScore: submitted?.avgScore ? Number(submitted.avgScore) : null,
      totalParticipants: participantTotals?.total ?? 0,
    };
  }

  async questionAnalytics(orgId: string, surveyId: number, versionId: number) {
    const questions = await this.db.query.surveyQuestions.findMany({
      where: and(eq(surveyQuestions.orgId, orgId), eq(surveyQuestions.versionId, versionId)),
      with: { choices: true },
    });

    const results = [];
    for (const question of questions) {
      const answers = await this.db.query.surveyAnswers.findMany({
        where: and(eq(surveyAnswers.orgId, orgId), eq(surveyAnswers.questionId, question.id)),
      });

      const choiceDistribution: Record<number, number> = {};
      for (const answer of answers) {
        for (const choiceId of (answer.choiceIds as number[] | null) ?? []) {
          choiceDistribution[choiceId] = (choiceDistribution[choiceId] ?? 0) + 1;
        }
      }

      const numericAnswers = answers
        .map((a) => (typeof a.answerValue === "number" ? a.answerValue : null))
        .filter((v): v is number => v !== null);
      const average = numericAnswers.length ? numericAnswers.reduce((s, v) => s + v, 0) / numericAnswers.length : null;

      results.push({
        questionId: question.id,
        type: question.type,
        title: question.title,
        responseCount: answers.length,
        average,
        choiceDistribution: question.choices.map((choice) => ({
          choiceId: choice.id,
          label: choice.label,
          count: choiceDistribution[choice.id] ?? 0,
        })),
        textResponses: question.type === "short_text" || question.type === "long_text" ? answers.map((a) => a.answerText).filter(Boolean) : undefined,
      });
    }

    return results;
  }
}
