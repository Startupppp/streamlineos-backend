import { BadRequestException, GoneException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { calendarEvents, candidates, interviewBookingLinks, interviews, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { EmailService } from "../email/email.service";
import { getBookingConfirmationEmail } from "../email/templates/interviews";
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
    const link = await this.db.query.interviewBookingLinks.findFirst({
      where: eq(interviewBookingLinks.token, token),
      with: { interviewers: { columns: { userId: true } } },
    });
    if (!link) throw new NotFoundException("Booking link not found.");
    if (link.status !== "pending") throw new GoneException("This booking link has already been used.");
    if (new Date() > link.expiresAt) throw new GoneException("This booking link has expired.");

    const slotStart = new Date(input.slotStart);
    const validSlot = link.availableSlots.some((s) => new Date(s.start).getTime() === slotStart.getTime());
    if (!validSlot) throw new BadRequestException("Selected slot is not available.");

    const endDate = new Date(slotStart.getTime() + link.durationMinutes * 60_000);

    const interview = await this.db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(interviewBookingLinks)
        .set({ status: "booked", selectedSlot: slotStart, updatedAt: new Date() })
        .where(and(eq(interviewBookingLinks.id, link.id), eq(interviewBookingLinks.status, "pending")))
        .returning({ id: interviewBookingLinks.id });
      if (!claimed) throw new GoneException("This booking link has already been used.");

      const [created] = await tx
        .insert(interviews)
        .values({
          orgId: link.orgId,
          candidateId: link.candidateId,
          jobPostingId: link.jobPostingId,
          interviewerId: link.interviewers[0]?.userId ?? link.createdBy,
          type: TYPE_MAP[link.interviewType] ?? "VIDEO",
          scheduledAt: slotStart,
          duration: link.durationMinutes,
          notes: link.notes,
          result: "PENDING",
          remindersSent: {},
        })
        .returning({ id: interviews.id });

      await tx.insert(calendarEvents).values({
        orgId: link.orgId,
        title: "Interview (self-scheduled)",
        description: link.notes ?? `Self-scheduled ${link.interviewType} interview`,
        startDate: slotStart,
        endDate,
        allDay: false,
        category: "interview",
        entityType: "interview",
        entityId: String(created.id),
        createdBy: link.createdBy,
        attendeeIds: link.interviewers.map((i) => i.userId),
      });

      return created;
    });

    void this.notifyCreator(link.orgId, link.candidateId, link.createdBy, slotStart).catch(() => undefined);

    return { success: true, interviewId: interview.id };
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
      this.db.query.users.findFirst({ where: eq(users.id, creatorId), columns: { email: true } }),
    ]);
    if (!creator?.email) return;

    const candidateName = candidate ? `${candidate.firstName} ${candidate.lastName}` : "Candidate";
    const slotLabel = slotStart.toLocaleString("en-IN", {
      dateStyle: "full",
      timeStyle: "short",
      timeZone: "Asia/Kolkata",
    });
    const { subject, html } = getBookingConfirmationEmail(candidateName, slotLabel);
    await this.email.sendEmail({ to: creator.email, subject, html });
  }
}
