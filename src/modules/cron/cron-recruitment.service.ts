import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  candidateOffers,
  candidates,
  interviews,
  notifications,
  organizations,
  tasks,
} from "../../db/schema";
import { AccessService } from "../access/access.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { logger } from "../../common/logger/logger.service";
import { EmailService } from "../email/email.service";
import {
  getInterviewNoShowRescheduleEmail,
  getOfferDeadlineReminderEmail,
} from "../email/templates/recruitment";
import { forEachOrg } from "../../common/tenant";

const PENDING_OFFER_STATUSES = ["SENT", "VIEWED"] as const;
const NO_SHOW_FOLLOW_UP_DUE_MS = 24 * 60 * 60 * 1000;

interface DueOffer {
  offerId: number;
  orgId: string;
  candidateId: number;
  firstName: string;
  lastName: string;
  email: string;
  designation: string | null;
  validUntil: string | null;
  offerLetterUrl: string | null;
  orgName: string | null;
}

interface DueInterview {
  interviewId: number;
  orgId: string;
  candidateId: number;
  firstName: string;
  lastName: string;
  email: string;
  orgName: string | null;
}

@Injectable()
export class CronRecruitmentService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly email: EmailService,
    private readonly access: AccessService,
  ) {}

  async sendOfferDeadlineReminders(): Promise<{ remindedCount: number }> {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowDate = tomorrow.toISOString().slice(0, 10);

    let remindedCount = 0;

    await forEachOrg(this.db, "offer-deadline-reminders", async (tx, orgId) => {
      const dueOffers = await tx
        .select({
          offerId: candidateOffers.id,
          orgId: candidateOffers.orgId,
          candidateId: candidateOffers.candidateId,
          firstName: candidates.firstName,
          lastName: candidates.lastName,
          email: candidates.email,
          designation: candidateOffers.offeredDesignation,
          validUntil: candidateOffers.validUntil,
          offerLetterUrl: candidateOffers.offerLetterUrl,
          orgName: organizations.name,
        })
        .from(candidateOffers)
        .innerJoin(candidates, eq(candidateOffers.candidateId, candidates.id))
        .innerJoin(organizations, eq(candidateOffers.orgId, organizations.id))
        .where(
          and(
            eq(candidateOffers.orgId, orgId),
            eq(candidateOffers.validUntil, tomorrowDate),
            inArray(candidateOffers.offerStatus, [...PENDING_OFFER_STATUSES]),
          ),
        );

      for (const offer of dueOffers) {
        if (await this.remindOfferDeadline(offer)) remindedCount++;
      }

      logger.info("Offer deadline reminders processed for org", { orgId, due: dueOffers.length });
    });

    logger.info("Offer deadline reminder sweep complete", { remindedCount });
    return { remindedCount };
  }

  async processInterviewNoShows(): Promise<{ processedCount: number }> {
    let processedCount = 0;

    await forEachOrg(this.db, "interview-no-shows", async (tx, orgId) => {
      const dueInterviews = await tx
        .select({
          interviewId: interviews.id,
          orgId: interviews.orgId,
          candidateId: interviews.candidateId,
          firstName: candidates.firstName,
          lastName: candidates.lastName,
          email: candidates.email,
          orgName: organizations.name,
        })
        .from(interviews)
        .innerJoin(candidates, eq(interviews.candidateId, candidates.id))
        .innerJoin(organizations, eq(interviews.orgId, organizations.id))
        .where(
          and(
            eq(interviews.orgId, orgId),
            eq(interviews.result, "PENDING"),
            sql`${interviews.scheduledAt} + make_interval(mins => ${interviews.duration}) < now()`,
          ),
        );

      if (dueInterviews.length === 0) return;

      const hrByOrg = new Map<string, string[]>();
      for (const interview of dueInterviews) {
        if (await this.flagInterviewNoShow(interview, hrByOrg)) processedCount++;
      }

      logger.info("Interview no-shows processed for org", { orgId, due: dueInterviews.length });
    });

    logger.info("Interview no-show sweep complete", { processedCount });
    return { processedCount };
  }

  private async remindOfferDeadline(offer: DueOffer): Promise<boolean> {
    if (!offer.email) return false;

    const candidateName = `${offer.firstName} ${offer.lastName}`.trim();
    const orgName = offer.orgName ?? "";
    const { subject, html } = getOfferDeadlineReminderEmail({
      candidateName,
      orgName,
      designation: offer.designation,
      deadlineLabel: this.formatDeadline(offer.validUntil),
      offerLink: offer.offerLetterUrl,
    });

    try {
      await this.email.sendEmail({ to: offer.email, subject, html });
      return true;
    } catch (error) {
      logger.error("Failed to send offer deadline reminder", { offerId: offer.offerId, error });
      return false;
    }
  }

  private async flagInterviewNoShow(
    interview: DueInterview,
    hrByOrg: Map<string, string[]>,
  ): Promise<boolean> {
    const [flagged] = await this.db
      .update(interviews)
      .set({ result: "NO_SHOW", updatedAt: new Date() })
      .where(and(eq(interviews.id, interview.interviewId), eq(interviews.result, "PENDING")))
      .returning({ id: interviews.id });

    if (!flagged) return false;

    const candidateName = `${interview.firstName} ${interview.lastName}`.trim();
    const hrMembers = await this.resolveHrMembers(interview.orgId, hrByOrg);

    try {
      await this.createNoShowFollowUp(interview, candidateName, hrMembers);
      await this.notifyNoShow(interview, candidateName, hrMembers);
    } catch (error) {
      logger.error("Failed to record interview no-show follow-up", {
        interviewId: interview.interviewId,
        error,
      });
    }

    await this.sendNoShowEmail(interview, candidateName);
    return true;
  }

  private async createNoShowFollowUp(
    interview: DueInterview,
    candidateName: string,
    hrMembers: string[],
  ): Promise<void> {
    const assigneeId = hrMembers[0] ?? null;
    await this.db.insert(tasks).values({
      orgId: interview.orgId,
      title: `Follow up: No-show — ${candidateName}`,
      notes: `Interview #${interview.interviewId} was marked as a no-show. Please follow up with the candidate to reschedule or close the application.`,
      type: "CALL",
      status: "pending",
      assigneeId,
      createdBy: assigneeId,
      dueDate: new Date(Date.now() + NO_SHOW_FOLLOW_UP_DUE_MS),
    });
  }

  private async notifyNoShow(
    interview: DueInterview,
    candidateName: string,
    hrMembers: string[],
  ): Promise<void> {
    if (hrMembers.length === 0) return;
    const rows: (typeof notifications.$inferInsert)[] = hrMembers.map((userId) => ({
      orgId: interview.orgId,
      userId,
      type: "WARNING",
      title: "Interview No-Show",
      message: `${candidateName} did not show up for interview #${interview.interviewId}. A follow-up task has been created.`,
      link: `/hr/recruitment/candidates/${interview.candidateId}`,
    }));
    await this.db.insert(notifications).values(rows);
  }

  private async sendNoShowEmail(interview: DueInterview, candidateName: string): Promise<void> {
    if (!interview.email) return;
    const orgName = interview.orgName ?? "";
    const { subject, html } = getInterviewNoShowRescheduleEmail(candidateName, orgName);
    try {
      await this.email.sendEmail({ to: interview.email, subject, html });
    } catch (error) {
      logger.error("Failed to send no-show reschedule email", {
        interviewId: interview.interviewId,
        error,
      });
    }
  }

  private async resolveHrMembers(orgId: string, cache: Map<string, string[]>): Promise<string[]> {
    const cached = cache.get(orgId);
    if (cached) return cached;

    const members = (await this.access.membersWithPermission(orgId, "hr:interviews:manage"))
      .map((m) => m.userId);
    cache.set(orgId, members);
    return members;
  }

  private formatDeadline(validUntil: string | null): string {
    if (!validUntil) return "soon";
    return new Date(`${validUntil}T12:00:00Z`).toLocaleDateString("en-IN", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }
}
