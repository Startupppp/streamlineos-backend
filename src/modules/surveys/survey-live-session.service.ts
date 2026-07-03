import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { surveyLiveSessions, surveyForms, surveyQuestions, surveySections } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CreateLiveSessionInput } from "./dto/survey-live-session.schemas";

function generateSessionCode(): string {
  return randomBytes(3).toString("hex").toUpperCase();
}

@Injectable()
export class SurveyLiveSessionService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async create(orgId: string, surveyId: number, hostUserId: string, input: CreateLiveSessionInput) {
    const survey = await this.db.query.surveyForms.findFirst({ where: and(eq(surveyForms.id, surveyId), eq(surveyForms.orgId, orgId)) });
    if (!survey) throw new NotFoundException("Survey not found");
    if (!survey.activeVersionId) throw new BadRequestException("Survey must be published before starting a live session");

    const [session] = await this.db
      .insert(surveyLiveSessions)
      .values({
        orgId,
        surveyId,
        versionId: survey.activeVersionId,
        hostUserId,
        sessionCode: generateSessionCode(),
        settings: input.settings ?? {},
      })
      .returning();
    return session;
  }

  async get(sessionId: number) {
    const session = await this.db.query.surveyLiveSessions.findFirst({ where: eq(surveyLiveSessions.id, sessionId) });
    if (!session) throw new NotFoundException("Live session not found");
    return session;
  }

  async getByCode(sessionCode: string) {
    const session = await this.db.query.surveyLiveSessions.findFirst({ where: eq(surveyLiveSessions.sessionCode, sessionCode) });
    if (!session) throw new NotFoundException("Live session not found");
    return session;
  }

  async start(sessionId: number) {
    const session = await this.get(sessionId);
    const firstQuestion = await this.db.query.surveyQuestions.findFirst({
      where: and(eq(surveyQuestions.orgId, session.orgId), eq(surveyQuestions.versionId, session.versionId)),
      orderBy: [asc(surveySections.sortOrder), asc(surveyQuestions.sortOrder)],
    });
    const [updated] = await this.db
      .update(surveyLiveSessions)
      .set({ status: "active", startedAt: new Date(), currentQuestionId: firstQuestion?.id ?? null })
      .where(eq(surveyLiveSessions.id, sessionId))
      .returning();
    return updated;
  }

  async next(sessionId: number) {
    const session = await this.get(sessionId);
    const questions = await this.db.query.surveyQuestions.findMany({
      where: and(eq(surveyQuestions.orgId, session.orgId), eq(surveyQuestions.versionId, session.versionId)),
      orderBy: [asc(surveyQuestions.sortOrder)],
    });
    const currentIndex = questions.findIndex((q) => q.id === session.currentQuestionId);
    const nextQuestion = questions[currentIndex + 1] ?? null;

    const [updated] = await this.db
      .update(surveyLiveSessions)
      .set({ currentQuestionId: nextQuestion?.id ?? null })
      .where(eq(surveyLiveSessions.id, sessionId))
      .returning();
    return updated;
  }

  async reveal(sessionId: number) {
    const session = await this.get(sessionId);
    const settings = { ...(session.settings ?? {}), revealed: true };
    const [updated] = await this.db.update(surveyLiveSessions).set({ settings }).where(eq(surveyLiveSessions.id, sessionId)).returning();
    return updated;
  }

  async end(sessionId: number) {
    const [updated] = await this.db
      .update(surveyLiveSessions)
      .set({ status: "ended", endedAt: new Date() })
      .where(eq(surveyLiveSessions.id, sessionId))
      .returning();
    if (!updated) throw new NotFoundException("Live session not found");
    return updated;
  }
}
