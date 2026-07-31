import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { candidates, interviewScorecards, interviews, organizations, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AutomationService } from "../../automation/automation.service";
import { EmailService } from "../../email/email.service";
import { logger } from "../../../common/logger/logger.service";
import { getCandidateFeedbackEmail } from "../../email/templates/interviews";
import type { SubmitScorecardInput, UpdateInterviewInput } from "./dto/interview-scheduling.schemas";

@Injectable()
export class HrInterviewResultsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly automation: AutomationService,
    private readonly email: EmailService,
  ) {}

  async updateInterview(orgId: string, interviewId: number, input: UpdateInterviewInput) {
    const existing = await this.db.query.interviews.findFirst({
      where: and(eq(interviews.id, interviewId), eq(interviews.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Interview not found.");

    const updateFields: Partial<typeof interviews.$inferInsert> = { updatedAt: new Date() };
    if (input.type !== undefined) updateFields.type = input.type;
    if (input.scheduledAt !== undefined) updateFields.scheduledAt = new Date(input.scheduledAt);
    if (input.duration !== undefined) updateFields.duration = input.duration;
    if (input.location !== undefined) updateFields.location = input.location;
    if (input.meetingLink !== undefined) updateFields.meetingLink = input.meetingLink || null;
    if (input.result !== undefined) updateFields.result = input.result;
    if (input.feedback !== undefined) updateFields.feedback = input.feedback;
    if (input.rating !== undefined) updateFields.rating = input.rating;
    if (input.rubric !== undefined) updateFields.rubric = input.rubric;
    if (input.notes !== undefined) updateFields.notes = input.notes;
    if (input.recordingUrl !== undefined) updateFields.recordingUrl = input.recordingUrl || null;
    if (input.recordingPlatform !== undefined) updateFields.recordingPlatform = input.recordingPlatform || null;

    await this.db.update(interviews).set(updateFields).where(eq(interviews.id, interviewId));

    if (input.result !== undefined && input.result !== "PENDING" && existing.result !== input.result) {
      const result = input.result;
      const rating = input.rating ?? null;
      void this.dispatchCompletedAutomation(
        orgId,
        interviewId,
        existing.candidateId,
        existing.interviewerId ?? "",
        result,
        rating,
      ).catch(() => undefined);
    }

    return { success: true };
  }

  async getScorecard(orgId: string, userId: string, interviewId: number) {
    const interview = await this.db.query.interviews.findFirst({
      where: and(eq(interviews.id, interviewId), eq(interviews.orgId, orgId)),
      columns: { id: true },
    });
    if (!interview) throw new NotFoundException("Interview not found.");

    const scorecard = await this.db.query.interviewScorecards.findFirst({
      where: and(
        eq(interviewScorecards.interviewId, interviewId),
        eq(interviewScorecards.interviewerId, userId),
      ),
    });

    return scorecard ?? null;
  }

  async submitScorecard(orgId: string, userId: string, interviewId: number, input: SubmitScorecardInput) {
    const interview = await this.db.query.interviews.findFirst({
      where: and(eq(interviews.id, interviewId), eq(interviews.orgId, orgId)),
      columns: { id: true, candidateId: true },
    });
    if (!interview) throw new NotFoundException("Interview not found.");

    const existing = await this.db.query.interviewScorecards.findFirst({
      where: and(
        eq(interviewScorecards.interviewId, interviewId),
        eq(interviewScorecards.interviewerId, userId),
      ),
    });
    if (existing?.submittedAt) {
      throw new ForbiddenException("Scorecard already submitted.");
    }

    let scorecard: typeof interviewScorecards.$inferSelect;
    if (existing) {
      const [updated] = await this.db
        .update(interviewScorecards)
        .set({
          ratings: input.ratings,
          recommendation: input.recommendation,
          notes: input.notes ?? null,
          ...(input.templateId !== undefined && { templateId: input.templateId }),
          ...(input.isBlindMode !== undefined && { isBlindMode: input.isBlindMode }),
          submittedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(interviewScorecards.id, existing.id))
        .returning();
      scorecard = updated;
    } else {
      const [created] = await this.db
        .insert(interviewScorecards)
        .values({
          interviewId,
          interviewerId: userId,
          templateId: input.templateId ?? null,
          ratings: input.ratings,
          recommendation: input.recommendation,
          notes: input.notes ?? null,
          isBlindMode: input.isBlindMode ?? false,
          submittedAt: new Date(),
        })
        .returning();
      scorecard = created;
    }

    void this.dispatchScorecardAutomation(
      orgId,
      userId,
      interviewId,
      interview.candidateId,
      input.recommendation,
    ).catch(() => undefined);

    void this.sendCandidateFeedbackEmail(orgId, interviewId, interview.candidateId).catch(
      () => undefined,
    );

    return scorecard;
  }

  private async sendCandidateFeedbackEmail(
    orgId: string,
    interviewId: number,
    candidateId: number,
  ): Promise<void> {
    const [interview, candidate, org] = await Promise.all([
      this.db.query.interviews.findFirst({
        where: and(eq(interviews.id, interviewId), eq(interviews.orgId, orgId)),
        columns: { scheduledAt: true },
      }),
      this.db.query.candidates.findFirst({
        where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
        columns: { firstName: true, lastName: true, email: true },
      }),
      this.db.query.organizations.findFirst({
        where: eq(organizations.id, orgId),
        columns: { name: true },
      }),
    ]);

    if (!interview || !candidate?.email) return;

    const candidateName = `${candidate.firstName} ${candidate.lastName}`.trim();
    const { subject, html } = getCandidateFeedbackEmail({
      candidateName,
      orgName: org?.name ?? "StreamlineOS",
      scheduledAt: interview.scheduledAt,
    });

    try {
      await this.email.sendEmail({ to: candidate.email, subject, html });
    } catch (error) {
      logger.error("Failed to send candidate feedback email", { interviewId, error });
    }
  }

  private async dispatchCompletedAutomation(
    orgId: string,
    interviewId: number,
    candidateId: number,
    interviewerId: string,
    result: "PENDING" | "PASSED" | "FAILED" | "NO_SHOW",
    rating: number | null,
  ): Promise<void> {
    const candidate = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
      columns: { firstName: true, lastName: true },
    });

    await this.automation.runAutomationsForEvent(orgId, "interview.completed", {
      interviewId,
      candidateId,
      candidateName: candidate ? `${candidate.firstName} ${candidate.lastName}` : "",
      jobTitle: "",
      result,
      rating,
      interviewerId,
      completedAt: new Date().toISOString(),
    });
  }

  private async dispatchScorecardAutomation(
    orgId: string,
    userId: string,
    interviewId: number,
    candidateId: number,
    recommendation: string,
  ): Promise<void> {
    const [candidate, interviewer] = await Promise.all([
      this.db.query.candidates.findFirst({
        where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
        columns: { firstName: true, lastName: true },
      }),
      this.db.query.users.findFirst({ where: eq(users.id, userId), columns: { name: true } }),
    ]);

    await this.automation.runAutomationsForEvent(orgId, "scorecard.submitted", {
      interviewId,
      candidateId,
      candidateName: candidate ? `${candidate.firstName} ${candidate.lastName}` : "",
      interviewerName: interviewer?.name ?? "",
      recommendation,
      submittedAt: new Date().toISOString(),
    });
  }
}
