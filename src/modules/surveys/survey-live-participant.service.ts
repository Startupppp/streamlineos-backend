import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import {
  surveyLiveSessions,
  surveyResponseSessions,
  surveyAnswers,
  surveyQuestionChoices,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { JoinLiveSessionInput, SubmitLiveAnswerInput } from "./dto/survey-live-session.schemas";

type LiveSession = typeof surveyLiveSessions.$inferSelect;

const MAX_QUESTION_CHOICES = 500;

@Injectable()
export class SurveyLiveParticipantService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private liveSessionMatches(orgId: string, liveSessionId: number) {
    return and(
      eq(surveyResponseSessions.orgId, orgId),
      sql`${surveyResponseSessions.metadata}->>'liveSessionId' = ${String(liveSessionId)}`,
    );
  }

  async join(session: LiveSession, input: JoinLiveSessionInput) {
    if (session.status === "ended") throw new BadRequestException("This live session has ended");

    const [responseSession] = await this.db
      .insert(surveyResponseSessions)
      .values({
        orgId: session.orgId,
        surveyId: session.surveyId,
        versionId: session.versionId,
        anonymous: !input.email,
        metadata: { liveSessionId: session.id, name: input.name ?? null, email: input.email ?? null },
      })
      .returning();

    return { participantToken: String(responseSession.id) };
  }

  private async getResponseSessionForToken(orgId: string, liveSessionId: number, participantToken: string) {
    const responseSessionId = Number(participantToken);
    if (!Number.isInteger(responseSessionId)) throw new BadRequestException("Invalid participant token");

    const responseSession = await this.db.query.surveyResponseSessions.findFirst({
      where: and(eq(surveyResponseSessions.id, responseSessionId), eq(surveyResponseSessions.orgId, orgId)),
    });
    if (!responseSession || (responseSession.metadata as { liveSessionId?: number })?.liveSessionId !== liveSessionId) {
      throw new NotFoundException("Participant not found for this session");
    }
    return responseSession;
  }

  async submitAnswer(session: LiveSession, input: SubmitLiveAnswerInput) {
    if (session.currentQuestionId !== input.questionId) {
      throw new BadRequestException("This question is no longer active");
    }
    const responseSession = await this.getResponseSessionForToken(session.orgId, session.id, input.participantToken);

    let score: number | null = null;
    if (input.choiceIds?.length) {
      const choices = await this.db.query.surveyQuestionChoices.findMany({
        where: eq(surveyQuestionChoices.questionId, input.questionId),
        limit: MAX_QUESTION_CHOICES,
      });
      const selected = choices.filter((c) => input.choiceIds!.includes(c.id));
      if (selected.length) score = selected.reduce((sum, c) => sum + (c.score ?? 0), 0);
    }

    await this.db
      .delete(surveyAnswers)
      .where(
        and(
          eq(surveyAnswers.orgId, session.orgId),
          eq(surveyAnswers.sessionId, responseSession.id),
          eq(surveyAnswers.questionId, input.questionId),
        ),
      );

    await this.db.insert(surveyAnswers).values({
      orgId: session.orgId,
      sessionId: responseSession.id,
      surveyId: session.surveyId,
      versionId: session.versionId,
      questionId: input.questionId,
      answerValue: input.answerValue ?? null,
      choiceIds: input.choiceIds ?? null,
      score,
    });

    return { success: true };
  }

  async getQuestionResults(orgId: string, liveSessionId: number, questionId: number) {
    const grouped = await this.db
      .select({ choiceIds: surveyAnswers.choiceIds, answers: sql<number>`count(*)::int` })
      .from(surveyAnswers)
      .innerJoin(
        surveyResponseSessions,
        and(
          eq(surveyResponseSessions.id, surveyAnswers.sessionId),
          eq(surveyResponseSessions.orgId, surveyAnswers.orgId),
        ),
      )
      .where(and(eq(surveyAnswers.orgId, orgId), eq(surveyAnswers.questionId, questionId), this.liveSessionMatches(orgId, liveSessionId)))
      .groupBy(surveyAnswers.choiceIds);

    const choiceCounts: Record<number, number> = {};
    let responseCount = 0;
    for (const row of grouped) {
      const answers = Number(row.answers);
      responseCount += answers;
      for (const choiceId of (row.choiceIds as number[] | null) ?? []) {
        choiceCounts[choiceId] = (choiceCounts[choiceId] ?? 0) + answers;
      }
    }

    const choices = await this.db.query.surveyQuestionChoices.findMany({
      where: and(eq(surveyQuestionChoices.orgId, orgId), eq(surveyQuestionChoices.questionId, questionId)),
      limit: MAX_QUESTION_CHOICES,
    });
    return {
      responseCount,
      choiceDistribution: choices.map((c) => ({ choiceId: c.id, label: c.label, count: choiceCounts[c.id] ?? 0, isCorrect: c.isCorrect })),
    };
  }

  async getParticipantCount(orgId: string, liveSessionId: number) {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(surveyResponseSessions)
      .where(this.liveSessionMatches(orgId, liveSessionId));
    return row?.count ?? 0;
  }
}
