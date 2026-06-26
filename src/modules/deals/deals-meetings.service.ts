import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { dealMeetings, deals } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CreateMeetingInput, UpdateMeetingInput } from "./dto/deals.schemas";

@Injectable()
export class DealsMeetingsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listMeetings(orgId: string, dealId: number) {
    const deal = await this.db.query.deals.findFirst({
      where: and(eq(deals.id, dealId), eq(deals.orgId, orgId)),
      columns: { id: true },
    });
    if (!deal) throw new NotFoundException("Deal not found.");

    return this.db.query.dealMeetings.findMany({
      where: and(eq(dealMeetings.dealId, dealId), eq(dealMeetings.orgId, orgId)),
      with: { creator: { columns: { id: true, name: true } } },
      orderBy: [desc(dealMeetings.scheduledAt)],
    });
  }

  async createMeeting(orgId: string, userId: string, dealId: number, input: CreateMeetingInput) {
    const deal = await this.db.query.deals.findFirst({
      where: and(eq(deals.id, dealId), eq(deals.orgId, orgId)),
      columns: { id: true },
    });
    if (!deal) throw new NotFoundException("Deal not found.");

    const [meeting] = await this.db
      .insert(dealMeetings)
      .values({
        orgId,
        dealId,
        title: input.title,
        scheduledAt: new Date(input.scheduledAt),
        durationMinutes: input.durationMinutes,
        attendees: input.attendees,
        agenda: input.agenda ?? null,
        notes: input.notes ?? null,
        actionItems: input.actionItems ?? null,
        recordingLink: input.recordingLink || null,
        status: input.status,
        createdBy: userId,
      })
      .returning();

    return meeting;
  }

  async updateMeeting(orgId: string, dealId: number, meetingId: number, input: UpdateMeetingInput) {
    const existing = await this.db.query.dealMeetings.findFirst({
      where: and(
        eq(dealMeetings.id, meetingId),
        eq(dealMeetings.dealId, dealId),
        eq(dealMeetings.orgId, orgId),
      ),
    });
    if (!existing) throw new NotFoundException("Meeting not found.");

    const values: Partial<typeof dealMeetings.$inferInsert> = { updatedAt: new Date() };
    if (input.title !== undefined) values.title = input.title;
    if (input.scheduledAt !== undefined) values.scheduledAt = new Date(input.scheduledAt);
    if (input.durationMinutes !== undefined) values.durationMinutes = input.durationMinutes;
    if (input.attendees !== undefined) values.attendees = input.attendees;
    if (input.agenda !== undefined) values.agenda = input.agenda;
    if (input.notes !== undefined) values.notes = input.notes;
    if (input.actionItems !== undefined) values.actionItems = input.actionItems;
    if (input.recordingLink !== undefined) values.recordingLink = input.recordingLink || null;
    if (input.status !== undefined) values.status = input.status;

    const [updated] = await this.db
      .update(dealMeetings)
      .set(values)
      .where(eq(dealMeetings.id, meetingId))
      .returning();

    return updated;
  }

  async deleteMeeting(orgId: string, dealId: number, meetingId: number) {
    const existing = await this.db.query.dealMeetings.findFirst({
      where: and(
        eq(dealMeetings.id, meetingId),
        eq(dealMeetings.dealId, dealId),
        eq(dealMeetings.orgId, orgId),
      ),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Meeting not found.");

    await this.db.delete(dealMeetings).where(eq(dealMeetings.id, meetingId));

    return { success: true };
  }
}
