import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { surveyAssessmentAttempts, surveyCertificates, surveyForms } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { ListAttemptsInput } from "./dto/survey-assessment.schemas";

interface AssessmentSettings {
  passScore?: number;
  attemptsAllowed?: number;
  timeLimitMinutes?: number;
  certificateOnPass?: boolean;
}

@Injectable()
export class SurveyAssessmentService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listAttempts(orgId: string, surveyId: number, filters: ListAttemptsInput) {
    const conditions = [eq(surveyAssessmentAttempts.orgId, orgId), eq(surveyAssessmentAttempts.surveyId, surveyId)];
    if (filters.status) conditions.push(eq(surveyAssessmentAttempts.status, filters.status));
    return this.db.query.surveyAssessmentAttempts.findMany({
      where: and(...conditions),
      orderBy: [desc(surveyAssessmentAttempts.startedAt)],
      limit: filters.pageSize,
      offset: (filters.page - 1) * filters.pageSize,
    });
  }

  async createAttempt(orgId: string, surveyId: number, participantId: number | null) {
    const survey = await this.db.query.surveyForms.findFirst({ where: and(eq(surveyForms.id, surveyId), eq(surveyForms.orgId, orgId)) });
    if (!survey) throw new NotFoundException("Survey not found");
    if (survey.mode !== "assessment") throw new BadRequestException("Survey is not in assessment mode");
    if (!survey.activeVersionId) throw new BadRequestException("Assessment has not been published");

    const settings = (survey.settings ?? {}) as AssessmentSettings;
    const priorAttempts = participantId
      ? await this.db.query.surveyAssessmentAttempts.findMany({
          where: and(eq(surveyAssessmentAttempts.orgId, orgId), eq(surveyAssessmentAttempts.surveyId, surveyId), eq(surveyAssessmentAttempts.participantId, participantId)),
        })
      : [];

    if (settings.attemptsAllowed && priorAttempts.length >= settings.attemptsAllowed) {
      throw new BadRequestException("No attempts remaining");
    }

    const expiresAt = settings.timeLimitMinutes ? new Date(Date.now() + settings.timeLimitMinutes * 60_000) : null;

    const [attempt] = await this.db
      .insert(surveyAssessmentAttempts)
      .values({
        orgId,
        surveyId,
        versionId: survey.activeVersionId,
        participantId,
        attemptNumber: priorAttempts.length + 1,
        status: "in_progress",
        startedAt: new Date(),
        expiresAt,
      })
      .returning();

    return attempt;
  }

  async completeAttempt(orgId: string, surveyId: number, sessionId: number, score: number) {
    const survey = await this.db.query.surveyForms.findFirst({ where: and(eq(surveyForms.id, surveyId), eq(surveyForms.orgId, orgId)) });
    if (!survey) return null;

    const settings = (survey.settings ?? {}) as AssessmentSettings;
    const passScore = settings.passScore ?? 0;
    const passed = score >= passScore;

    const attempt = await this.db.query.surveyAssessmentAttempts.findFirst({
      where: and(eq(surveyAssessmentAttempts.orgId, orgId), eq(surveyAssessmentAttempts.sessionId, sessionId)),
    });
    if (!attempt) return null;

    const [updated] = await this.db
      .update(surveyAssessmentAttempts)
      .set({ status: passed ? "passed" : "failed", score, passed, submittedAt: new Date() })
      .where(eq(surveyAssessmentAttempts.id, attempt.id))
      .returning();

    if (passed && settings.certificateOnPass && attempt.participantId) {
      await this.issueCertificate(orgId, surveyId, attempt.participantId, updated.id);
    }

    return updated;
  }

  async linkAttemptToSession(attemptId: number, sessionId: number) {
    await this.db.update(surveyAssessmentAttempts).set({ sessionId }).where(eq(surveyAssessmentAttempts.id, attemptId));
  }

  async issueCertificate(orgId: string, surveyId: number, participantId: number, attemptId: number) {
    const [certificate] = await this.db
      .insert(surveyCertificates)
      .values({
        orgId,
        surveyId,
        participantId,
        attemptId,
        certificateNumber: `CERT-${randomUUID().slice(0, 8).toUpperCase()}`,
      })
      .returning();
    return certificate;
  }

  listCertificates(orgId: string, surveyId: number) {
    return this.db.query.surveyCertificates.findMany({
      where: and(eq(surveyCertificates.orgId, orgId), eq(surveyCertificates.surveyId, surveyId)),
      orderBy: [desc(surveyCertificates.issuedAt)],
    });
  }
}
