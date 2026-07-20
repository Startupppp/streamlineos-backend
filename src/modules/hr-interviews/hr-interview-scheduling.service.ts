import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  bookingLinkInterviewers,
  calendarEvents,
  candidates,
  interviewBookingLinks,
  interviewPanelMembers,
  interviews,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { NotificationsService } from "../notifications/notifications.service";
import { EmailService } from "../email/email.service";
import { AutomationService } from "../automation/automation.service";
import { getInterviewInviteEmail, getSelfScheduleBookingEmail } from "../email/templates/interviews";
import type {
  CreateInterviewInput,
  ScheduleInterviewInput,
  SelfScheduleInput,
} from "./dto/interview-scheduling.schemas";

const INTERVIEW_TYPES = ["PHONE", "VIDEO", "ONSITE", "TECHNICAL", "HR", "FINAL"] as const;
type InterviewType = (typeof INTERVIEW_TYPES)[number];

const FORMAT_TO_TYPE: Record<"VIDEO" | "PHONE" | "IN_PERSON", InterviewType> = {
  VIDEO: "VIDEO",
  PHONE: "PHONE",
  IN_PERSON: "ONSITE",
};

const FORMAT_LABEL: Record<"VIDEO" | "PHONE" | "IN_PERSON", string> = {
  VIDEO: "Video Call",
  PHONE: "Phone Call",
  IN_PERSON: "In-Person",
};

function toInterviewType(value: string | undefined): InterviewType {
  return INTERVIEW_TYPES.find((t) => t === value) ?? "VIDEO";
}

function bookingBaseUrl(): string {
  const url = process.env.APP_URL?.trim();
  if (!url) throw new Error("APP_URL is required for interview booking links");
  return url.replace(/\/$/, "");
}

interface InterviewRow {
  id: number;
  candidateId: number;
  interviewerId: string | null;
  type: InterviewType;
  scheduledAt: Date;
  duration: number;
  meetingLink: string | null;
  notes: string | null;
}

@Injectable()
export class HrInterviewSchedulingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
    private readonly automation: AutomationService,
  ) {}

  async createInterview(orgId: string, input: CreateInterviewInput) {
    const [interview] = await this.db
      .insert(interviews)
      .values({
        orgId,
        candidateId: input.candidateId,
        jobPostingId: input.jobPostingId,
        interviewerId: input.interviewerId,
        type: toInterviewType(input.type),
        scheduledAt: new Date(input.scheduledAt),
        duration: input.duration ?? 60,
        location: input.location,
        meetingLink: input.meetingLink,
        notes: input.notes,
        result: "PENDING",
      })
      .returning();

    await this.cache.invalidatePattern(`hr:interviews:list:${orgId}:*`);

    void this.dispatchScheduledAutomation(orgId, interview, interview.interviewerId ?? "").catch(() => undefined);

    return interview;
  }

  async deleteInterview(orgId: string, interviewId: number) {
    await this.db
      .delete(interviews)
      .where(and(eq(interviews.id, interviewId), eq(interviews.orgId, orgId)));
    await this.cache.invalidatePattern(`hr:interviews:list:${orgId}:*`);
    return { success: true };
  }

  async scheduleInterview(orgId: string, userId: string, input: ScheduleInterviewInput) {
    const candidate = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.id, input.candidateId), eq(candidates.orgId, orgId)),
      columns: { id: true, firstName: true, lastName: true, email: true },
    });
    if (!candidate) throw new NotFoundException("Candidate not found");

    const scheduledDate = new Date(input.scheduledAt);
    if (scheduledDate <= new Date()) {
      throw new BadRequestException("Interview must be scheduled for a future date and time.");
    }
    const endDate = new Date(scheduledDate.getTime() + input.durationMinutes * 60_000);
    const primaryInterviewerId = input.interviewers[0];
    const candidateName = `${candidate.firstName} ${candidate.lastName}`;

    const interview = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(interviews)
        .values({
          orgId,
          candidateId: input.candidateId,
          jobPostingId: input.jobPostingId,
          interviewerId: primaryInterviewerId,
          type: FORMAT_TO_TYPE[input.format],
          scheduledAt: scheduledDate,
          duration: input.durationMinutes,
          meetingLink: input.meetLink,
          notes: input.notes,
          result: "PENDING",
          remindersSent: {},
        })
        .returning();

      await tx.insert(interviewPanelMembers).values(
        input.interviewers.map((uid) => ({ interviewId: created.id, orgId, userId: uid })),
      );

      return created;
    });

    await this.db.insert(calendarEvents).values({
      orgId,
      title: `Interview: ${candidateName}`,
      description: input.notes ?? `${input.format} interview with ${candidateName}`,
      startDate: scheduledDate,
      endDate,
      allDay: false,
      category: "interview",
      entityType: "interview",
      entityId: String(interview.id),
      createdBy: userId,
      attendeeIds: input.interviewers,
    });

    await Promise.all(
      input.interviewers.map((interviewerId) =>
        this.notifications.create({
          orgId,
          userId: interviewerId,
          type: "INFO",
          title: "New Interview Scheduled",
          message: `You have been assigned to interview ${candidateName} on ${scheduledDate.toLocaleString()}.`,
          link: `/hr/recruitment/interviews/${interview.id}`,
          metadata: { interviewId: interview.id, candidateId: input.candidateId },
        }),
      ),
    );

    if (input.notifyChannels.email) {
      void this.dispatchScheduleEmails(interview, candidate, input).catch(() => undefined);
    }

    void this.dispatchScheduledAutomation(orgId, interview, primaryInterviewerId).catch(() => undefined);

    return {
      ...interview,
      panelInterviewerIds: input.interviewers.length > 1 ? input.interviewers : [],
    };
  }

  async selfSchedule(orgId: string, userId: string, input: SelfScheduleInput) {
    const candidate = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.id, input.candidateId), eq(candidates.orgId, orgId)),
      columns: { id: true, firstName: true, lastName: true, email: true },
    });
    if (!candidate) throw new NotFoundException("Candidate not found");

    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);

    const link = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(interviewBookingLinks)
        .values({
          orgId,
          candidateId: input.candidateId,
          jobPostingId: input.jobPostingId,
          token,
          durationMinutes: input.durationMinutes,
          interviewType: input.interviewType,
          availableSlots: input.availableSlots,
          expiresAt,
          createdBy: userId,
          notes: input.notes,
        })
        .returning();

      await tx.insert(bookingLinkInterviewers).values(
        input.interviewerIds.map((uid) => ({ bookingLinkId: created.id, userId: uid })),
      );

      return created;
    });

    const bookingUrl = `${bookingBaseUrl()}/interview-booking/${token}`;

    if (candidate.email) {
      const candidateName = `${candidate.firstName} ${candidate.lastName}`.trim();
      const expiresLabel = expiresAt.toLocaleDateString("en-IN", { dateStyle: "long" });
      const { subject, html } = getSelfScheduleBookingEmail(candidateName, bookingUrl, expiresLabel);
      void this.email.sendEmail({ to: candidate.email, subject, html }).catch(() => undefined);
    }

    return { id: link.id, token, bookingUrl, expiresAt: expiresAt.toISOString() };
  }

  private async dispatchScheduleEmails(
    interview: InterviewRow,
    candidate: { firstName: string; lastName: string; email: string | null },
    input: ScheduleInterviewInput,
  ): Promise<void> {
    const candidateName = `${candidate.firstName} ${candidate.lastName}`;
    const dateLabel = interview.scheduledAt.toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    });
    const formatLabel = FORMAT_LABEL[input.format];

    const interviewerUsers = await this.db
      .select({
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
      })
      .from(users)
      .where(inArray(users.id, input.interviewers));

    const tasks: Promise<void>[] = [];

    for (const interviewer of interviewerUsers) {
      if (!interviewer.email) continue;
      const { subject, html } = getInterviewInviteEmail({
        recipientName: `${interviewer.firstName ?? ""} ${interviewer.lastName ?? ""}`.trim() || "Interviewer",
        candidateName,
        jobTitle: "this position",
        companyName: process.env.APP_BRAND_NAME ?? "StreamlineOS",
        scheduledAt: dateLabel,
        durationMinutes: input.durationMinutes,
        format: formatLabel,
        notes: input.notes,
        recipientRole: "interviewer",
      });
      tasks.push(this.email.sendEmail({ to: interviewer.email, subject, html }));
    }

    if (candidate.email) {
      const { subject, html } = getInterviewInviteEmail({
        recipientName: candidateName,
        candidateName,
        jobTitle: "this position",
        companyName: process.env.APP_BRAND_NAME ?? "StreamlineOS",
        scheduledAt: dateLabel,
        durationMinutes: input.durationMinutes,
        format: formatLabel,
        notes: input.notes,
        recipientRole: "candidate",
      });
      tasks.push(this.email.sendEmail({ to: candidate.email, subject, html }));
    }

    await Promise.allSettled(tasks);
  }

  private async dispatchScheduledAutomation(
    orgId: string,
    interview: InterviewRow,
    primaryInterviewerId: string,
  ): Promise<void> {
    const candidate = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.id, interview.candidateId), eq(candidates.orgId, orgId)),
      columns: { firstName: true, lastName: true, email: true },
    });

    await this.automation.runAutomationsForEvent(orgId, "interview.scheduled", {
      interviewId: interview.id,
      candidateId: interview.candidateId,
      candidateName: candidate ? `${candidate.firstName} ${candidate.lastName}` : "",
      candidateEmail: candidate?.email ?? "",
      jobTitle: "",
      interviewerId: primaryInterviewerId,
      interviewerEmail: "",
      type: interview.type,
      scheduledAt: interview.scheduledAt.toISOString(),
      durationMinutes: interview.duration ?? 60,
      meetingLink: interview.meetingLink ?? null,
    });
  }
}
