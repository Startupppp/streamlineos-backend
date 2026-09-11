import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { surveyAssessmentAttempts, surveyCertificates, surveyForms } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { assertSurveyInOrg } from "./survey-tenant";
import type { ListAttemptsInput } from "./dto/survey-assessment.schemas";
import { buildListResponse, paginateOffset } from "../../common/pagination/pagination";

interface AssessmentSettings {
  passScore?: number;
  attemptsAllowed?: number;
  timeLimitMinutes?: number;
  certificateOnPass?: boolean;
}

function readAssessmentSettings(settings: Record<string, unknown> | null): AssessmentSettings {
  const passScore = settings?.["passScore"];
  const attemptsAllowed = settings?.["attemptsAllowed"];
  const timeLimitMinutes = settings?.["timeLimitMinutes"];
  const certificateOnPass = settings?.["certificateOnPass"];
  return {
    passScore: typeof passScore === "number" ? passScore : undefined,
    attemptsAllowed: typeof attemptsAllowed === "number" ? attemptsAllowed : undefined,
    timeLimitMinutes: typeof timeLimitMinutes === "number" ? timeLimitMinutes : undefined,
    certificateOnPass: typeof certificateOnPass === "boolean" ? certificateOnPass : undefined,
  };
}

@Injectable()
export class SurveyAssessmentService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listAttempts(orgId: string, surveyId: number, filters: ListAttemptsInput) {
    await assertSurveyInOrg(this.db, orgId, surveyId);
    const conditions = [eq(surveyAssessmentAttempts.orgId, orgId), eq(surveyAssessmentAttempts.surveyId, surveyId)];
    if (filters.status) conditions.push(eq(surveyAssessmentAttempts.status, filters.status));
    const where = and(...conditions);
    const { limit, offset } = paginateOffset(filters);

    const [rows, [totalRow]] = await Promise.all([
      this.db.query.surveyAssessmentAttempts.findMany({
        where,
        orderBy: [desc(surveyAssessmentAttempts.startedAt)],
        limit,
        offset,
      }),
      this.db.select({ total: count() }).from(surveyAssessmentAttempts).where(where),
    ]);

    return buildListResponse(rows, Number(totalRow?.total ?? 0), filters);
  }

  async createAttempt(orgId: string, surveyId: number, participantId: number | null) {
    const survey = await this.db.query.surveyForms.findFirst({ where: and(eq(surveyForms.id, surveyId), eq(surveyForms.orgId, orgId), isNull(surveyForms.archivedAt)) });
    if (!survey) throw new NotFoundException("Survey not found");
    if (survey.mode !== "assessment") throw new BadRequestException("Survey is not in assessment mode");
    if (!survey.activeVersionId) throw new BadRequestException("Assessment has not been published");

    const settings = readAssessmentSettings(survey.settings);
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

    const settings = readAssessmentSettings(survey.settings);
    const passScore = settings.passScore ?? 0;
    const passed = score >= passScore;

    const attempt = await this.db.query.surveyAssessmentAttempts.findFirst({
      where: and(eq(surveyAssessmentAttempts.orgId, orgId), eq(surveyAssessmentAttempts.sessionId, sessionId)),
    });
    if (!attempt) return null;

    const [updated] = await this.db
      .update(surveyAssessmentAttempts)
      .set({ status: passed ? "passed" : "failed", score, passed, submittedAt: new Date() })
      .where(and(eq(surveyAssessmentAttempts.id, attempt.id), eq(surveyAssessmentAttempts.orgId, orgId)))
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

  async listCertificates(orgId: string, surveyId: number) {
    await assertSurveyInOrg(this.db, orgId, surveyId);
    return this.db.query.surveyCertificates.findMany({
      where: and(eq(surveyCertificates.orgId, orgId), eq(surveyCertificates.surveyId, surveyId)),
      orderBy: [desc(surveyCertificates.issuedAt)],
      limit: 100,
    });
  }
}
