import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, gte, inArray, isNull, lt, notInArray, sql } from "drizzle-orm";
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
    | "title"
    | "type"
    | "status"
    | "agenda"
    | "notes"
    | "scheduledAt"
    | "endAt"
    | "durationMinutes"
    | "timezone"
    | "recurrenceRule"
    | "sprintId"
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

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(todayStart.getTime() + 86400000);
    const weekEnd = new Date(todayStart.getTime() + 7 * 86400000);

    const dateClause = (() => {
      if (query.dateFilter === "today") return and(gte(projectMeetings.scheduledAt, todayStart), lt(projectMeetings.scheduledAt, todayEnd));
      if (query.dateFilter === "this_week") return and(gte(projectMeetings.scheduledAt, todayStart), lt(projectMeetings.scheduledAt, weekEnd));
      if (query.dateFilter === "upcoming") return gte(projectMeetings.scheduledAt, now);
      if (query.dateFilter === "past") return lt(projectMeetings.scheduledAt, now);
      return undefined;
    })();

    let hostMeetingIds: number[] | undefined;
    if (query.hostId) {
      const rows = await this.db
        .select({ id: projectMeetings.id })
        .from(projectMeetings)
        .where(and(eq(projectMeetings.orgId, orgId), eq(projectMeetings.projectId, projectId), eq(projectMeetings.createdBy, query.hostId), isNull(projectMeetings.deletedAt)));
      hostMeetingIds = rows.map((r) => r.id);
    }

    let attendeeMeetingIds: number[] | undefined;
    if (query.attendeeId) {
      const rows = await this.db
        .select({ meetingId: meetingAttendees.meetingId })
        .from(meetingAttendees)
        .where(and(eq(meetingAttendees.orgId, orgId), eq(meetingAttendees.userId, query.attendeeId)));
      attendeeMeetingIds = rows.map((r) => r.meetingId);
    }

    const meetings = await this.db
      .select()
      .from(projectMeetings)
      .where(
        and(
          eq(projectMeetings.orgId, orgId),
          eq(projectMeetings.projectId, projectId),
          isNull(projectMeetings.deletedAt),
          query.status ? eq(projectMeetings.status, query.status) : undefined,
          query.type ? eq(projectMeetings.type, query.type) : undefined,
          dateClause,
          hostMeetingIds !== undefined ? (hostMeetingIds.length > 0 ? inArray(projectMeetings.id, hostMeetingIds) : sql`false`) : undefined,
          attendeeMeetingIds !== undefined ? (attendeeMeetingIds.length > 0 ? inArray(projectMeetings.id, attendeeMeetingIds) : sql`false`) : undefined,
        ),
      )
      .orderBy(sql`${projectMeetings.scheduledAt} DESC NULLS LAST`);

    if (meetings.length === 0) return meetings;
    const ids = meetings.map((m) => m.id);
    const [attCounts, aiCounts, unresolvedAiCounts] = await Promise.all([
      this.db
        .select({ meetingId: meetingAttendees.meetingId, count: sql<number>`count(*)::int` })
        .from(meetingAttendees)
        .where(and(eq(meetingAttendees.orgId, orgId), inArray(meetingAttendees.meetingId, ids)))
        .groupBy(meetingAttendees.meetingId),
      this.db
        .select({ meetingId: meetingActionItems.meetingId, count: sql<number>`count(*)::int` })
        .from(meetingActionItems)
        .where(
          and(
            eq(meetingActionItems.orgId, orgId),
            inArray(meetingActionItems.meetingId, ids),
            isNull(meetingActionItems.deletedAt),
          ),
        )
        .groupBy(meetingActionItems.meetingId),
      this.db
        .select({ meetingId: meetingActionItems.meetingId, count: sql<number>`count(*)::int` })
        .from(meetingActionItems)
        .where(
          and(
            eq(meetingActionItems.orgId, orgId),
            inArray(meetingActionItems.meetingId, ids),
            isNull(meetingActionItems.deletedAt),
            notInArray(meetingActionItems.status, ["done", "converted", "cancelled"]),
          ),
        )
        .groupBy(meetingActionItems.meetingId),
    ]);
    const attMap = new Map(attCounts.map((r) => [r.meetingId, r.count]));
    const aiMap = new Map(aiCounts.map((r) => [r.meetingId, r.count]));
    const unresolvedAiMap = new Map(unresolvedAiCounts.map((r) => [r.meetingId, r.count]));

    const result = meetings.map((m) => ({
      ...m,
      attendeeCount: attMap.get(m.id) ?? 0,
      actionItemCount: aiMap.get(m.id) ?? 0,
      unresolvedActionItemCount: unresolvedAiMap.get(m.id) ?? 0,
    }));

    if (query.hasActionItems === true) return result.filter((m) => m.actionItemCount > 0);
    if (query.hasUnresolvedActionItems === true) return result.filter((m) => m.unresolvedActionItemCount > 0);
    return result;
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
    return { ...meeting, attendees, actionItems, standupEntries };
  }

  async createMeeting(orgId: string, userId: string, projectId: number, input: CreateMeetingInput) {
    await this.assertProject(orgId, projectId);

    if (input.attendeeUserIds && input.attendeeUserIds.length > 0) {
      const members = await this.db
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, projectId),
            inArray(projectMembers.userId, input.attendeeUserIds),
          ),
        );
      const memberSet = new Set(members.map((m) => m.userId));
      const invalid = input.attendeeUserIds.filter((id) => !memberSet.has(id));
      if (invalid.length > 0) throw new BadRequestException(`Users are not project members: ${invalid.join(", ")}`);
    }

    const meeting = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${projectId})`);
      const [maxRow] = await tx
        .select({ maxNum: sql<number>`COALESCE(MAX(${projectMeetings.meetingNumber}), 0)` })
        .from(projectMeetings)
        .where(and(eq(projectMeetings.projectId, projectId), eq(projectMeetings.orgId, orgId)));
      const nextNumber = (maxRow?.maxNum ?? 0) + 1;
      const [created] = await tx
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
          endAt: input.endAt ?? null,
          durationMinutes: input.durationMinutes ?? null,
          timezone: input.timezone ?? null,
          recurrenceRule: input.recurrenceRule ?? null,
          sprintId: input.sprintId ?? null,
          createdBy: userId,
        })
        .returning();
      if (!created) throw new NotFoundException("Failed to create meeting");

      if (input.attendeeUserIds && input.attendeeUserIds.length > 0) {
        await tx.insert(meetingAttendees).values(
          input.attendeeUserIds.map((uid) => ({ orgId, meetingId: created.id, userId: uid })),
        ).onConflictDoNothing();
      }

      return created;
    });

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
    if (input.endAt !== undefined) patch.endAt = input.endAt ?? null;
    if (input.durationMinutes !== undefined) patch.durationMinutes = input.durationMinutes ?? null;
    if (input.timezone !== undefined) patch.timezone = input.timezone ?? null;
    if (input.recurrenceRule !== undefined) patch.recurrenceRule = input.recurrenceRule ?? null;
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
