import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  projectMeetings,
  meetingAttendees,
  meetingActionItems,
  meetingStandupEntries,
  projects,
  projectMembers,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import type {
  AddAttendeeInput,
  CreateMeetingInput,
  ListMeetingsQuery,
  UpdateMeetingInput,
  UpsertStandupInput,
} from "./dto/meetings.schemas";

type MeetingPatch = Partial<
  Pick<
    typeof projectMeetings.$inferInsert,
    "title" | "type" | "status" | "agenda" | "notes" | "scheduledAt" | "durationMinutes" | "sprintId"
  >
>;

@Injectable()
export class MeetingsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private async assertProject(orgId: string, projectId: number): Promise<void> {
    const p = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.orgId, orgId)),
      columns: { id: true },
    });
    if (!p) throw new NotFoundException("Project not found");
  }

  private async loadMeeting(orgId: string, projectId: number, meetingId: number) {
    const row = await this.db.query.projectMeetings.findFirst({
      where: and(
        eq(projectMeetings.id, meetingId),
        eq(projectMeetings.orgId, orgId),
        eq(projectMeetings.projectId, projectId),
        isNull(projectMeetings.deletedAt),
      ),
    });
    if (!row) throw new NotFoundException("Meeting not found");
    return row;
  }

  async listMeetings(orgId: string, projectId: number, query: ListMeetingsQuery) {
    await this.assertProject(orgId, projectId);
    return this.db
      .select()
      .from(projectMeetings)
      .where(
        and(
          eq(projectMeetings.orgId, orgId),
          eq(projectMeetings.projectId, projectId),
          isNull(projectMeetings.deletedAt),
          query.status ? eq(projectMeetings.status, query.status) : undefined,
          query.type ? eq(projectMeetings.type, query.type) : undefined,
        ),
      )
      .orderBy(sql`${projectMeetings.scheduledAt} DESC NULLS LAST`);
  }

  async getMeeting(orgId: string, projectId: number, meetingId: number) {
    const meeting = await this.loadMeeting(orgId, projectId, meetingId);
    const [attendees, actionItems, standupEntries] = await Promise.all([
      this.db
        .select()
        .from(meetingAttendees)
        .where(and(eq(meetingAttendees.meetingId, meetingId), eq(meetingAttendees.orgId, orgId))),
      this.db
        .select()
        .from(meetingActionItems)
        .where(
          and(
            eq(meetingActionItems.meetingId, meetingId),
            eq(meetingActionItems.orgId, orgId),
            isNull(meetingActionItems.deletedAt),
          ),
        ),
      this.db
        .select()
        .from(meetingStandupEntries)
        .where(and(eq(meetingStandupEntries.meetingId, meetingId), eq(meetingStandupEntries.orgId, orgId))),
    ]);
    return { meeting, attendees, actionItems, standupEntries };
  }

  async createMeeting(orgId: string, userId: string, projectId: number, input: CreateMeetingInput) {
    await this.assertProject(orgId, projectId);
    const [meeting] = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${projectId})`);
      const [maxRow] = await tx
        .select({ maxNum: sql<number>`COALESCE(MAX(${projectMeetings.meetingNumber}), 0)` })
        .from(projectMeetings)
        .where(and(eq(projectMeetings.projectId, projectId), eq(projectMeetings.orgId, orgId)));
      const nextNumber = (maxRow?.maxNum ?? 0) + 1;
      return tx
        .insert(projectMeetings)
        .values({
          orgId,
          projectId,
          meetingNumber: nextNumber,
          title: input.title,
          type: input.type ?? "meeting",
          status: input.status ?? "scheduled",
          agenda: input.agenda ?? null,
          notes: input.notes ?? null,
          scheduledAt: input.scheduledAt ?? null,
          durationMinutes: input.durationMinutes ?? null,
          sprintId: input.sprintId ?? null,
          createdBy: userId,
        })
        .returning();
    });
    if (!meeting) throw new NotFoundException("Failed to create meeting");
    this.audit.log({
      action: "meeting.created",
      userId,
      orgId,
      resourceType: "project_meeting",
      resourceId: String(meeting.id),
      metadata: { projectId, meetingId: meeting.id, title: meeting.title },
    });
    return meeting;
  }

  async updateMeeting(
    orgId: string,
    userId: string,
    projectId: number,
    meetingId: number,
    input: UpdateMeetingInput,
  ) {
    await this.loadMeeting(orgId, projectId, meetingId);
    const patch: MeetingPatch = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.type !== undefined) patch.type = input.type;
    if (input.status !== undefined) patch.status = input.status;
    if (input.agenda !== undefined) patch.agenda = input.agenda ?? null;
    if (input.notes !== undefined) patch.notes = input.notes ?? null;
    if (input.scheduledAt !== undefined) patch.scheduledAt = input.scheduledAt ?? null;
    if (input.durationMinutes !== undefined) patch.durationMinutes = input.durationMinutes ?? null;
    if (input.sprintId !== undefined) patch.sprintId = input.sprintId ?? null;
    const [updated] = await this.db
      .update(projectMeetings)
      .set(patch)
      .where(and(eq(projectMeetings.id, meetingId), eq(projectMeetings.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Meeting not found");
    this.audit.log({
      action: "meeting.updated",
      userId,
      orgId,
      resourceType: "project_meeting",
      resourceId: String(meetingId),
      metadata: { projectId, meetingId },
    });
    return updated;
  }

  async deleteMeeting(orgId: string, userId: string, projectId: number, meetingId: number) {
    await this.loadMeeting(orgId, projectId, meetingId);
    await this.db
      .update(projectMeetings)
      .set({ deletedAt: new Date() })
      .where(and(eq(projectMeetings.id, meetingId), eq(projectMeetings.orgId, orgId)));
    this.audit.log({
      action: "meeting.deleted",
      userId,
      orgId,
      resourceType: "project_meeting",
      resourceId: String(meetingId),
      metadata: { projectId, meetingId },
    });
  }

  async addAttendee(orgId: string, userId: string, projectId: number, meetingId: number, input: AddAttendeeInput) {
    await this.loadMeeting(orgId, projectId, meetingId);
    const [member] = await this.db
      .select({ id: projectMembers.id })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, input.userId)))
      .limit(1);
    if (!member) throw new BadRequestException("User is not a project member");
    await this.db
      .insert(meetingAttendees)
      .values({ orgId, meetingId, userId: input.userId })
      .onConflictDoNothing();
    return { meetingId, userId: input.userId };
  }

  async removeAttendee(orgId: string, userId: string, projectId: number, meetingId: number, attendeeUserId: string) {
    await this.loadMeeting(orgId, projectId, meetingId);
    await this.db
      .delete(meetingAttendees)
      .where(
        and(
          eq(meetingAttendees.meetingId, meetingId),
          eq(meetingAttendees.userId, attendeeUserId),
          eq(meetingAttendees.orgId, orgId),
        ),
      );
  }

  async upsertStandup(orgId: string, userId: string, projectId: number, meetingId: number, input: UpsertStandupInput) {
    await this.loadMeeting(orgId, projectId, meetingId);
    const [entry] = await this.db
      .insert(meetingStandupEntries)
      .values({
        orgId,
        meetingId,
        userId,
        yesterday: input.yesterday ?? null,
        today: input.today ?? null,
        blockers: input.blockers ?? null,
      })
      .onConflictDoUpdate({
        target: [meetingStandupEntries.meetingId, meetingStandupEntries.userId],
        set: {
          yesterday: input.yesterday ?? null,
          today: input.today ?? null,
          blockers: input.blockers ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();
    return entry;
  }
}
