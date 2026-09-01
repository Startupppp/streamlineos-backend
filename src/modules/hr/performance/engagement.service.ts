import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, gte, or } from "drizzle-orm";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import {
  assessmentAttempts,
  enpsScores,
  feedbackRequests,
  hrAuditLogs,
  pulseSurveys,
  recognitions,
  skillAssessments,
  surveyResponses,
  organizationMembers,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  createAssessmentSchema,
  createSurveySchema,
  submitAssessmentSchema,
  submitSurveyResponseSchema,
} from "./dto/engagement.schemas";
import type {
  CreateEnpsInput,
  CreateFeedbackInput,
  CreateRecognitionInput,
  SubmitFeedbackInput,
  UpdateSurveyInput,
} from "./dto/engagement.schemas";
import { EngagementBadgesService } from "./engagement-badges.service";

@Injectable()
export class EngagementService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly engagementBadges: EngagementBadgesService,
  ) {}

  listFeedback(orgId: string, userId: string) {
    return this.db
      .select()
      .from(feedbackRequests)
      .where(
        and(
          eq(feedbackRequests.orgId, orgId),
          or(
            eq(feedbackRequests.subjectUserId, userId),
            eq(feedbackRequests.reviewerUserId, userId),
          ),
        ),
      )
      .orderBy(desc(feedbackRequests.createdAt))
      .limit(100);
  }

  async createFeedback(orgId: string, input: CreateFeedbackInput) {
    if (input.subjectUserId === input.reviewerUserId && input.type !== "SELF") {
      throw new BadRequestException(
        "Subject and reviewer cannot be the same person for non-self feedback.",
      );
    }

    const [record] = await this.db
      .insert(feedbackRequests)
      .values({
        orgId,
        subjectUserId: input.subjectUserId,
        reviewerUserId: input.reviewerUserId,
        type: input.type,
        cycleId: input.cycleId ?? null,
      })
      .returning();

    return record;
  }

  async submitFeedback(
    orgId: string,
    userId: string,
    feedbackId: number,
    input: SubmitFeedbackInput,
  ) {
    const [existing] = await this.db
      .select()
      .from(feedbackRequests)
      .where(
        and(
          eq(feedbackRequests.id, feedbackId),
          eq(feedbackRequests.orgId, orgId),
          eq(feedbackRequests.reviewerUserId, userId),
        ),
      );

    if (!existing) throw new NotFoundException("Feedback request not found.");
    if (existing.isCompleted)
      throw new BadRequestException("Feedback already submitted.");

    const [updated] = await this.db
      .update(feedbackRequests)
      .set({
        ratings: input.ratings,
        strengths: input.strengths ?? null,
        improvements: input.improvements ?? null,
        overallRating: input.overallRating ?? null,
        isCompleted: true,
        completedAt: new Date(),
      })
      .where(
        and(
          eq(feedbackRequests.id, feedbackId),
          eq(feedbackRequests.orgId, orgId),
        ),
      )
      .returning();

    return updated;
  }

  listAssessments(orgId: string) {
    return this.db.query.skillAssessments.findMany({
      where: eq(skillAssessments.orgId, orgId),
      with: { attempts: true },
      orderBy: [desc(skillAssessments.createdAt)],
      limit: 100,
    });
  }

  async createOrSubmitAssessment(
    orgId: string,
    userId: string,
    isAdmin: boolean,
    action: string | undefined,
    body: unknown,
  ) {
    if (action === "submit") {
      const input = submitAssessmentSchema.parse(body);
      const assessment = await this.db.query.skillAssessments.findFirst({
        where: and(
          eq(skillAssessments.id, input.assessmentId),
          eq(skillAssessments.orgId, orgId),
        ),
      });
      if (!assessment) throw new NotFoundException("Assessment not found.");

      const questions = assessment.questions ?? [];
      let correct = 0;
      for (const answer of input.answers) {
        const q = questions.find((item) => item.id === answer.questionId);
        if (q && q.correctIndex === answer.selectedIndex) correct++;
      }
      const score =
        questions.length > 0
          ? Math.round((correct / questions.length) * 100)
          : 0;
      const passed = score >= (assessment.passingScore ?? 70);

      const [attempt] = await this.db
        .insert(assessmentAttempts)
        .values({
          assessmentId: input.assessmentId,
          userId,
          answers: input.answers,
          score,
          passed,
        })
        .returning();

      return { ...attempt, score, passed, correct, total: questions.length };
    }

    if (!isAdmin)
      throw new ForbiddenException("Only admins can create assessments.");
    const input = createAssessmentSchema.parse(body);
    const [assessment] = await this.db
      .insert(skillAssessments)
      .values({
        orgId,
        title: input.title,
        skillName: input.skillName ?? input.category ?? "",
        questions: input.questions ?? [],
        passingScore: input.passingScore,
        timeLimit: input.durationMinutes ?? input.timeLimit,
        createdBy: userId,
      })
      .returning();

    return assessment;
  }

  listRecognitions(orgId: string) {
    return this.db.query.recognitions.findMany({
      where: eq(recognitions.orgId, orgId),
      with: {
        fromUser: {
          columns: { id: true, name: true, email: true, image: true },
        },
        toUser: { columns: { id: true, name: true, email: true, image: true } },
      },
      orderBy: [desc(recognitions.createdAt)],
      limit: 100,
    });
  }

  async createRecognition(
    u: CurrentUserContext,
    input: CreateRecognitionInput,
  ) {
    const membershipId = actingMembershipId(u.principal);
    if (membershipId == null) {
      throw new ForbiddenException("Organization membership required");
    }
    const recipient = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, u.orgId),
        eq(organizationMembers.userId, input.toUserId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
      columns: { id: true },
    });
    if (!recipient) throw new BadRequestException("Recipient must be an active organization member.");
    if (recipient.id === membershipId) {
      throw new BadRequestException("You cannot send kudos to yourself.");
    }

    const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const existing = await this.db.query.recognitions.findFirst({
      where: and(
        eq(recognitions.orgId, u.orgId),
        eq(recognitions.fromMembershipId, membershipId),
        eq(recognitions.toMembershipId, recipient.id),
        gte(recognitions.createdAt, windowStart),
      ),
      columns: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        "You have already recognized this employee in the last 24 hours.",
      );
    }

    const [recognition] = await this.db
      .insert(recognitions)
      .values({
        orgId: u.orgId,
        fromUserId: u.userId,
        fromMembershipId: membershipId,
        toUserId: input.toUserId,
        toMembershipId: recipient.id,
        message: input.message,
        category: input.category,
      })
      .returning();

    await this.db.insert(hrAuditLogs).values({
      orgId: u.orgId,
      actorMembershipId: membershipId,
      entityType: "hr_recognition",
      entityId: String(recognition.id),
      action: "kudos_given",
      after: {
        toUserId: input.toUserId,
        message: input.message,
        category: input.category,
      },
    });

    this.engagementBadges
      .grantKudosPoints(u.orgId, input.toUserId, String(recognition.id))
      .catch(() => undefined);

    return recognition;
  }

  listEnps(orgId: string) {
    return this.db
      .select()
      .from(enpsScores)
      .where(eq(enpsScores.orgId, orgId))
      .orderBy(desc(enpsScores.createdAt))
      .limit(100);
  }

  async createEnps(orgId: string, userId: string, input: CreateEnpsInput) {
    const now = new Date();
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    const [record] = await this.db
      .insert(enpsScores)
      .values({
        orgId,
        userId: input.isAnonymous ? null : userId,
        score: input.score,
        comment: input.comment ?? null,
        isAnonymous: input.isAnonymous ?? true,
        period,
      })
      .returning();

    return record;
  }

  listSurveys(orgId: string) {
    return this.db.query.pulseSurveys.findMany({
      where: eq(pulseSurveys.orgId, orgId),
      with: { responses: true },
      orderBy: [desc(pulseSurveys.createdAt)],
      limit: 100,
    });
  }

  async createOrRespondSurvey(
    orgId: string,
    userId: string,
    isAdmin: boolean,
    action: string | undefined,
    body: unknown,
  ) {
    if (action === "respond") {
      const input = submitSurveyResponseSchema.parse(body);
      const survey = await this.db.query.pulseSurveys.findFirst({
        where: and(
          eq(pulseSurveys.id, input.surveyId),
          eq(pulseSurveys.orgId, orgId),
        ),
      });
      if (!survey) throw new NotFoundException("Survey not found.");
      if (survey.status !== "ACTIVE")
        throw new BadRequestException("Survey is not active.");

      const [response] = await this.db
        .insert(surveyResponses)
        .values({
          surveyId: input.surveyId,
          userId: survey.isAnonymous ? null : userId,
          answers: input.answers,
        })
        .returning();

      return response;
    }

    if (!isAdmin)
      throw new ForbiddenException("Only admins can create surveys.");
    const input = createSurveySchema.parse(body);
    const [survey] = await this.db
      .insert(pulseSurveys)
      .values({
        orgId,
        title: input.title,
        questions: input.questions,
        isAnonymous: input.isAnonymous,
        closesAt: input.closesAt ? new Date(input.closesAt) : undefined,
        status: "DRAFT",
        createdBy: userId,
      })
      .returning();

    return survey;
  }

  async updateSurvey(
    orgId: string,
    surveyId: number,
    input: UpdateSurveyInput,
  ) {
    await this.db
      .update(pulseSurveys)
      .set({
        ...(input.status !== undefined && { status: input.status }),
        ...(input.title !== undefined && { title: input.title }),
      })
      .where(and(eq(pulseSurveys.id, surveyId), eq(pulseSurveys.orgId, orgId)));

    return { success: true };
  }
}
