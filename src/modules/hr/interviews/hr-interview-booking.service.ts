import {
  BadRequestException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import {
  calendarEvents,
  candidates,
  eventAttendees,
  interviewBookingLinks,
  interviewPanelMembers,
  interviews,
  organizationMembers,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { withPublicToken } from "../../../common/tenant/with-public-token";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { EmailService } from "../../email/email.service";
import { getBookingConfirmationEmail } from "../../email/templates/interviews";
import type { BookInterviewInput } from "./dto/interview-scheduling.schemas";

const TYPE_MAP: Record<string, "VIDEO" | "PHONE" | "ONSITE"> = {
  VIDEO: "VIDEO",
  PHONE: "PHONE",
  IN_PERSON: "ONSITE",
};

@Injectable()
export class HrInterviewBookingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly email: EmailService,
  ) {}

  async book(token: string, input: BookInterviewInput) {
    const linkStub = await withPublicToken(this.db, token, (tx) =>
      tx.query.interviewBookingLinks.findFirst({
        where: eq(interviewBookingLinks.token, token),
        columns: { id: true, orgId: true },
      }),
    );
    if (!linkStub) throw new NotFoundException("Booking link not found.");

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const link = await tx.query.interviewBookingLinks.findFirst({
          where: eq(interviewBookingLinks.token, token),
          columns: { createdBy: true, createdByMembershipId: true },
          with: { interviewers: { columns: { userId: true, userMembershipId: true } } },
        });
        if (!link) throw new NotFoundException("Booking link not found.");
        if (link.status !== "pending")
          throw new GoneException("This booking link has already been used.");
        if (new Date() > link.expiresAt)
          throw new GoneException("This booking link has expired.");
        if (link.createdByMembershipId == null)
          throw new BadRequestException("Booking link creator membership is required.");

        const slotStart = new Date(input.slotStart);
        const validSlot = link.availableSlots.some(
          (s) => new Date(s.start).getTime() === slotStart.getTime(),
        );
        if (!validSlot)
          throw new BadRequestException("Selected slot is not available.");

        const endDate = new Date(
          slotStart.getTime() + link.durationMinutes * 60_000,
        );

        const [claimed] = await tx
          .update(interviewBookingLinks)
          .set({
            status: "booked",
            selectedSlot: slotStart,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(interviewBookingLinks.id, link.id),
              eq(interviewBookingLinks.status, "pending"),
            ),
          )
          .returning({ id: interviewBookingLinks.id });
        if (!claimed)
          throw new GoneException("This booking link has already been used.");

        const [created] = await tx
          .insert(interviews)
          .values({
            orgId: link.orgId,
            candidateId: link.candidateId,
            jobPostingId: link.jobPostingId,
            interviewerId: link.interviewers[0]?.userId ?? link.createdBy,
            interviewerMembershipId: link.interviewers[0]?.userMembershipId ?? link.createdByMembershipId,
            type: TYPE_MAP[link.interviewType] ?? "VIDEO",
            scheduledAt: slotStart,
            duration: link.durationMinutes,
            notes: link.notes,
            result: "PENDING",
            remindersSent: {},
          })
          .returning({ id: interviews.id });
        if (!created)
          throw new BadRequestException("Failed to create the interview.");

        const panelMembers = link.interviewers.filter(
          (interviewer): interviewer is { userId: string; userMembershipId: number } =>
            interviewer.userMembershipId != null,
        );
        if (panelMembers.length !== link.interviewers.length)
          throw new BadRequestException("Booking link interviewer membership is required.");
        if (panelMembers.length > 0) {
          await tx.insert(interviewPanelMembers).values(
            panelMembers.map((interviewer) => ({
              orgId: link.orgId,
              interviewId: created.id,
              userId: interviewer.userId,
              userMembershipId: interviewer.userMembershipId,
            })),
          );
        }

        const [calendarEvent] = await tx
          .insert(calendarEvents)
          .values({
            orgId: link.orgId,
            title: "Interview (self-scheduled)",
            description:
              link.notes ?? `Self-scheduled ${link.interviewType} interview`,
            startDate: slotStart,
            endDate,
            allDay: false,
            category: "interview",
            entityType: "interview",
            entityId: String(created.id),
            createdByMembershipId: link.createdByMembershipId,
          })
          .returning({ id: calendarEvents.id });
        if (calendarEvent && panelMembers.length > 0)
          await tx.insert(eventAttendees).values(
            panelMembers.map((membership) => ({
              orgId: link.orgId,
              eventId: calendarEvent.id,
              membershipId: membership.userMembershipId,
            })),
          );

        void this.notifyCreator(
          link.orgId,
          link.candidateId,
          link.createdBy,
          slotStart,
        ).catch(() => undefined);

        return { success: true, interviewId: created.id };
      },
      { orgId: linkStub.orgId },
    );
  }

  private async notifyCreator(
    orgId: string,
    candidateId: number,
    creatorId: string,
    slotStart: Date,
  ): Promise<void> {
    const [candidate, creator] = await Promise.all([
      this.db.query.candidates.findFirst({
        where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
        columns: { firstName: true, lastName: true },
      }),
      this.db.query.users.findFirst({
        where: eq(users.id, creatorId),
        columns: { email: true },
      }),
    ]);
    if (!creator?.email) return;

    const candidateName = candidate
      ? `${candidate.firstName} ${candidate.lastName}`
      : "Candidate";
    const slotLabel = slotStart.toLocaleString("en-IN", {
      dateStyle: "full",
      timeStyle: "short",
      timeZone: "Asia/Kolkata",
    });
    const { subject, html } = getBookingConfirmationEmail(
      candidateName,
      slotLabel,
    );
    await this.email.sendEmail({ to: creator.email, subject, html });
  }
}
