import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { OutboxWriter } from "../../common/outbox/outbox-writer";
import {
  surveyVersions,
  surveyForms,
  surveyResponseSessions,
  surveyAnswers,
  surveyQuestionChoices,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { SurveyCollectorService } from "./survey-collector.service";
import { SurveyParticipantService } from "./survey-participant.service";
import { SurveyAutomationService } from "./survey-automation.service";
import { SurveyAssessmentService } from "./survey-assessment.service";
import { SurveyLeadAutomationService } from "./survey-lead-automation.service";
import type { SaveAnswerInput, StartSessionInput } from "./dto/survey-public.schemas";
import type { ListResponsesInput } from "./dto/survey-analytics.schemas";

@Injectable()
export class SurveyResponseService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly collectors: SurveyCollectorService,
    private readonly participants: SurveyParticipantService,
    private readonly automations: SurveyAutomationService,
    private readonly assessments: SurveyAssessmentService,
    private readonly leadAutomations: SurveyLeadAutomationService,
  ) {}

  async getPublicSurvey(collectorToken: string) {
    const collector = await this.collectors.getByToken(collectorToken);
    const survey = collector.survey;
    if (!survey || survey.status !== "published" || !survey.activeVersionId) {
      throw new NotFoundException("This survey is not currently accepting responses");
    }

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const version = await tx.query.surveyVersions.findFirst({ where: eq(surveyVersions.id, survey.activeVersionId!) });
        await this.collectors.incrementCounter(collector.id, "opens");

        return {
          survey: { id: survey.id, title: survey.title, description: survey.description, mode: survey.mode, defaultLanguage: survey.defaultLanguage, branding: survey.branding, settings: survey.settings },
          schema: version?.schemaSnapshot ?? null,
        };
      },
      { orgId: collector.orgId },
    );
  }

  async startSession(collectorToken: string, input: StartSessionInput) {
    const collector = await this.collectors.getByToken(collectorToken);
    const survey = collector.survey;
    if (!survey || survey.status !== "published" || !survey.activeVersionId) {
      throw new NotFoundException("This survey is not currently accepting responses");
    }
    if (collector.status !== "active") throw new BadRequestException("This collector is not active");
    if (collector.expiresAt && collector.expiresAt < new Date()) throw new BadRequestException("This collector has expired");

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        let participantId: number | null = null;
        if (input.accessToken) {
          const participant = await this.participants.findByAccessToken(input.accessToken);
          participantId = participant.id;
          await this.participants.markStatus(participant.id, "started", "startedAt");
        }

        const [session] = await tx
          .insert(surveyResponseSessions)
          .values({
            orgId: survey.orgId,
            surveyId: survey.id,
            versionId: survey.activeVersionId!,
            collectorId: collector.id,
            participantId,
            anonymous: !input.accessToken && !input.participantEmail,
            metadata: input.metadata ?? {},
          })
          .returning();

        if (!session) throw new BadRequestException("Failed to start response session");

        await this.collectors.incrementCounter(collector.id, "starts");
        this.automations.record(survey.orgId, survey.id, session.id, "survey.response.started", {}).catch(() => undefined);

        if (survey.mode === "assessment") {
          const attempt = await this.assessments.createAttempt(survey.orgId, survey.id, participantId);
          await this.assessments.linkAttemptToSession(attempt.id, session.id);
        }

        return session;
      },
      { orgId: survey.orgId },
    );
  }

  private async resolveSessionOrgId(sessionId: number): Promise<string> {
    const rows = await this.db.execute(
      sql`SELECT app.resolve_survey_session_org_id(${sessionId}) AS org_id`,
    );
    const orgId = rows[0]?.org_id ? String(rows[0].org_id) : null;
    if (!orgId) throw new NotFoundException("Response session not found");
    return orgId;
  }

  private async getSession(sessionId: number) {
    const session = await this.db.query.surveyResponseSessions.findFirst({ where: eq(surveyResponseSessions.id, sessionId) });
    if (!session) throw new NotFoundException("Response session not found");
    return session;
  }

  async saveAnswers(sessionId: number, answers: SaveAnswerInput[]) {
    const orgId = await this.resolveSessionOrgId(sessionId);

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const session = await this.getSession(sessionId);
        if (session.status !== "in_progress") throw new BadRequestException("This response has already been submitted");
        if (answers.length === 0) return { success: true };

        const choicesByQuestion = await this.prefetchChoices(answers);
        const rows = this.buildAnswerRows(session, answers, choicesByQuestion);
        const questionIds = answers.map((a) => a.questionId);

        await tx
          .delete(surveyAnswers)
          .where(and(eq(surveyAnswers.sessionId, session.id), inArray(surveyAnswers.questionId, questionIds)));
        await tx.insert(surveyAnswers).values(rows);

        return { success: true };
      },
      { orgId },
    );
  }

  private async prefetchChoices(
    answers: SaveAnswerInput[],
  ): Promise<Map<number, (typeof surveyQuestionChoices.$inferSelect)[]>> {
    const choiceQuestionIds = answers.filter((a) => a.choiceIds?.length).map((a) => a.questionId);
    if (choiceQuestionIds.length === 0) return new Map();

    const rows = await this.db.query.surveyQuestionChoices.findMany({
      where: inArray(surveyQuestionChoices.questionId, choiceQuestionIds),
    });

    const map = new Map<number, (typeof surveyQuestionChoices.$inferSelect)[]>();
    for (const row of rows) {
      const list = map.get(row.questionId) ?? [];
      list.push(row);
      map.set(row.questionId, list);
    }
    return map;
  }

  private buildAnswerRows(
    session: typeof surveyResponseSessions.$inferSelect,
    answers: SaveAnswerInput[],
    choicesByQuestion: Map<number, (typeof surveyQuestionChoices.$inferSelect)[]>,
  ): (typeof surveyAnswers.$inferInsert)[] {
    return answers.map((answer) => {
      let score: number | null = null;
      if (answer.choiceIds?.length) {
        const choices = choicesByQuestion.get(answer.questionId) ?? [];
        const selected = choices.filter((c) => answer.choiceIds!.includes(c.id));
        if (selected.length) score = selected.reduce((sum, c) => sum + (c.score ?? 0), 0);
      }
      return {
        orgId: session.orgId,
        sessionId: session.id,
        surveyId: session.surveyId,
        versionId: session.versionId,
        questionId: answer.questionId,
        answerValue: answer.answerValue ?? null,
        answerText: answer.answerText ?? null,
        choiceIds: answer.choiceIds ?? null,
        score,
      };
    });
  }

  async submit(sessionId: number, answers?: SaveAnswerInput[]) {
    const orgId = await this.resolveSessionOrgId(sessionId);

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const session = await this.getSession(sessionId);
        if (session.status !== "in_progress") throw new BadRequestException("This response has already been submitted");

        if (answers?.length) {
          const choicesByQuestion = await this.prefetchChoices(answers);
          const rows = this.buildAnswerRows(session, answers, choicesByQuestion);
          const questionIds = answers.map((a) => a.questionId);
          await tx
            .delete(surveyAnswers)
            .where(and(eq(surveyAnswers.sessionId, session.id), inArray(surveyAnswers.questionId, questionIds)));
          await tx.insert(surveyAnswers).values(rows);
        }

        const allAnswers = await tx.query.surveyAnswers.findMany({
          where: eq(surveyAnswers.sessionId, session.id),
          with: { question: { columns: { variableName: true } } },
        });
        const totalScore = allAnswers.reduce((sum, a) => sum + (a.score ?? 0), 0);
        const durationSeconds = Math.max(0, Math.round((Date.now() - session.startedAt.getTime()) / 1000));

        const survey = await tx.query.surveyForms.findFirst({ where: eq(surveyForms.id, session.surveyId) });
        let passed: boolean | null = null;
        if (survey?.mode === "assessment") {
          const attempt = await this.assessments.completeAttempt(session.orgId, session.surveyId, session.id, totalScore);
          passed = attempt?.passed ?? null;
        }

        const [updated] = await tx
          .update(surveyResponseSessions)
          .set({ status: "submitted", submittedAt: new Date(), durationSeconds, score: totalScore, passed })
          .where(eq(surveyResponseSessions.id, session.id))
          .returning();
        if (updated) {
          await OutboxWriter.emit(tx, {
            eventId: randomUUID(),
            organizationId: session.orgId,
            aggregateType: "survey_response",
            aggregateId: String(session.id),
            aggregateVersion: Date.now(),
            eventType: "survey.response.submitted",
            payload: {
              sessionId: session.id,
              surveyId: session.surveyId,
              orgId: session.orgId,
              score: totalScore,
              passed,
            },
            occurredAt: new Date(),
          });
        }

        if (session.collectorId) await this.collectors.incrementCounter(session.collectorId, "completions");
        if (session.participantId) await this.participants.markStatus(session.participantId, "completed", "completedAt");

        this.automations.record(session.orgId, session.surveyId, session.id, "survey.response.submitted", { score: totalScore, passed }).catch(() => undefined);

        if (survey) {
          this.automations
            .getRulesForEvent(session.orgId, session.surveyId, "survey.response.submitted")
            .then((rules) => (rules.length ? this.leadAutomations.run(survey, session, allAnswers, totalScore, rules) : undefined))
            .catch(() => undefined);
        }

        return updated;
      },
      { orgId },
    );
  }

  async listResponses(orgId: string, surveyId: number, filters: ListResponsesInput) {
    const conditions = [eq(surveyResponseSessions.orgId, orgId), eq(surveyResponseSessions.surveyId, surveyId)];
    if (filters.collectorId) conditions.push(eq(surveyResponseSessions.collectorId, filters.collectorId));
    if (filters.status) conditions.push(eq(surveyResponseSessions.status, filters.status));

    return this.db.query.surveyResponseSessions.findMany({
      where: and(...conditions),
      orderBy: [desc(surveyResponseSessions.startedAt)],
      limit: filters.pageSize,
      offset: (filters.page - 1) * filters.pageSize,
    });
  }

  async getResponse(orgId: string, surveyId: number, sessionId: number) {
    const session = await this.db.query.surveyResponseSessions.findFirst({
      where: and(eq(surveyResponseSessions.id, sessionId), eq(surveyResponseSessions.orgId, orgId), eq(surveyResponseSessions.surveyId, surveyId)),
    });
    if (!session) throw new NotFoundException("Response not found");

    const answers = await this.db.query.surveyAnswers.findMany({
      where: eq(surveyAnswers.sessionId, sessionId),
      orderBy: [asc(surveyAnswers.answeredAt)],
      with: { question: { with: { choices: true } } },
    });

    return { session, answers };
  }
}
