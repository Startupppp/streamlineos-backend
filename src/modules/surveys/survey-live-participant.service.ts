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

@Injectable()
export class SurveyLiveParticipantService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

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

  private async getResponseSessionForToken(liveSessionId: number, participantToken: string) {
    const responseSessionId = Number(participantToken);
    if (!Number.isInteger(responseSessionId)) throw new BadRequestException("Invalid participant token");

    const responseSession = await this.db.query.surveyResponseSessions.findFirst({
      where: eq(surveyResponseSessions.id, responseSessionId),
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
    const responseSession = await this.getResponseSessionForToken(session.id, input.participantToken);

    let score: number | null = null;
    if (input.choiceIds?.length) {
      const choices = await this.db.query.surveyQuestionChoices.findMany({
        where: eq(surveyQuestionChoices.questionId, input.questionId),
      });
      const selected = choices.filter((c) => input.choiceIds!.includes(c.id));
      if (selected.length) score = selected.reduce((sum, c) => sum + (c.score ?? 0), 0);
    }

    await this.db
      .delete(surveyAnswers)
      .where(and(eq(surveyAnswers.sessionId, responseSession.id), eq(surveyAnswers.questionId, input.questionId)));

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

  async getQuestionResults(liveSessionId: number, questionId: number) {
    const rows = await this.db
      .select({ choiceIds: surveyAnswers.choiceIds, answerValue: surveyAnswers.answerValue })
      .from(surveyAnswers)
      .innerJoin(surveyResponseSessions, eq(surveyResponseSessions.id, surveyAnswers.sessionId))
      .where(
        and(
          eq(surveyAnswers.questionId, questionId),
          sql`${surveyResponseSessions.metadata}->>'liveSessionId' = ${String(liveSessionId)}`,
        ),
      );

    const choiceCounts: Record<number, number> = {};
    let responseCount = 0;
    for (const row of rows) {
      responseCount += 1;
      for (const choiceId of (row.choiceIds as number[] | null) ?? []) {
        choiceCounts[choiceId] = (choiceCounts[choiceId] ?? 0) + 1;
      }
    }

    const choices = await this.db.query.surveyQuestionChoices.findMany({ where: eq(surveyQuestionChoices.questionId, questionId) });
    return {
      responseCount,
      choiceDistribution: choices.map((c) => ({ choiceId: c.id, label: c.label, count: choiceCounts[c.id] ?? 0, isCorrect: c.isCorrect })),
    };
  }

  async getParticipantCount(liveSessionId: number) {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(surveyResponseSessions)
      .where(sql`${surveyResponseSessions.metadata}->>'liveSessionId' = ${String(liveSessionId)}`);
    return row?.count ?? 0;
  }
}
