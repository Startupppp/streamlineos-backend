import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, gte, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { decodeCursor, encodeCursor } from "../../../common/pagination/cursor";
import { keysetInteger, keysetTimestamp } from "../../../common/pagination/keyset";
import {
  projectMeetings,
  meetingAttendees,
  meetingActionItems,
  meetingStandupEntries,
  projectMembers,
  organizationMembers,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { assertProjectAccess, assertProjectWriteAccess } from "../core";
import { AuditService } from "../../../common/audit/audit.service";
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
    | "cycleId"
  >
>;

@Injectable()
export class MeetingsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

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

  async listMeetings(u: CurrentUserContext, projectId: number, query: ListMeetingsQuery) {
    await assertProjectAccess(this.db, this.access, u, projectId);

    const { limit, cursor } = query;
    const pos = decodeCursor(cursor);

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

    const rawMeetings = await this.db
      .select()
      .from(projectMeetings)
      .where(
        and(
          eq(projectMeetings.orgId, u.orgId),
          eq(projectMeetings.projectId, projectId),
          isNull(projectMeetings.deletedAt),
          query.status ? eq(projectMeetings.status, query.status) : undefined,
          query.type ? eq(projectMeetings.type, query.type) : undefined,
          dateClause,
          query.hostId ? eq(projectMeetings.createdBy, query.hostId) : undefined,
          query.attendeeId
            ? sql`EXISTS (
                SELECT 1
                FROM ${meetingAttendees} ma
                INNER JOIN ${organizationMembers} om
                  ON om.id = ma.membership_id
                 AND om.org_id = ${u.orgId}
                 AND om.user_id = ${query.attendeeId}
                 AND om.status = 'ACTIVE'
                WHERE ma.meeting_id = ${projectMeetings.id}
                  AND ma.org_id = ${u.orgId}
              )`
            : undefined,
          query.hasActionItems === true
            ? sql`EXISTS (SELECT 1 FROM ${meetingActionItems} WHERE ${meetingActionItems.meetingId} = ${projectMeetings.id} AND ${meetingActionItems.orgId} = ${u.orgId} AND ${meetingActionItems.deletedAt} IS NULL)`
            : undefined,
          query.hasUnresolvedActionItems === true
            ? sql`EXISTS (SELECT 1 FROM ${meetingActionItems} WHERE ${meetingActionItems.meetingId} = ${projectMeetings.id} AND ${meetingActionItems.orgId} = ${u.orgId} AND ${meetingActionItems.deletedAt} IS NULL AND ${meetingActionItems.status} NOT IN ('done', 'converted', 'cancelled'))`
            : undefined,
          query.q
            ? sql`to_tsvector('english', coalesce(${projectMeetings.title}, '')) @@ plainto_tsquery('english', ${query.q})`
            : undefined,
          pos
            ? (() => {
                const posId = keysetInteger(pos.id);
                if (pos.sortValue === "NULL_BUCKET") {
                  return and(isNull(projectMeetings.scheduledAt), sql`${projectMeetings.id} < ${sql.param(posId, projectMeetings.id)}`);
                }
                const posScheduledAt = keysetTimestamp(pos.sortValue);
                return or(
                  isNull(projectMeetings.scheduledAt),
                  sql`${projectMeetings.scheduledAt} < ${sql.param(posScheduledAt, projectMeetings.scheduledAt)}`,
                  and(
                    sql`${projectMeetings.scheduledAt} = ${sql.param(posScheduledAt, projectMeetings.scheduledAt)}`,
                    sql`${projectMeetings.id} < ${sql.param(posId, projectMeetings.id)}`,
                  ),
                );
              })()
            : undefined,
        ),
      )
      .orderBy(
        sql`${projectMeetings.scheduledAt} IS NULL ASC`,
        sql`${projectMeetings.scheduledAt} DESC NULLS LAST`,
        desc(projectMeetings.id),
      )
      .limit(limit + 1);

    const hasMore = rawMeetings.length > limit;
    const meetings = hasMore ? rawMeetings.slice(0, limit) : rawMeetings;

    const ids = meetings.map((m) => m.id);
    const emptyCounts: { meetingId: number; count: number }[] = [];
    const [attCounts, aiCounts, unresolvedAiCounts] = ids.length === 0
      ? [emptyCounts, emptyCounts, emptyCounts]
      : await Promise.all([
      this.db
        .select({ meetingId: meetingAttendees.meetingId, count: sql<number>`count(*)::int` })
        .from(meetingAttendees)
        .where(and(eq(meetingAttendees.orgId, u.orgId), inArray(meetingAttendees.meetingId, ids)))
        .groupBy(meetingAttendees.meetingId),
      this.db
        .select({ meetingId: meetingActionItems.meetingId, count: sql<number>`count(*)::int` })
        .from(meetingActionItems)
        .where(
          and(
            eq(meetingActionItems.orgId, u.orgId),
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
            eq(meetingActionItems.orgId, u.orgId),
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

    const last = meetings[meetings.length - 1];
    const nextCursor = hasMore && last
      ? encodeCursor({
          sortValue: last.scheduledAt !== null ? last.scheduledAt.toISOString() : "NULL_BUCKET",
          id: String(last.id),
        })
      : null;

    return {
      data: result,
      pagination: { limit, hasMore, nextCursor },
    };
  }

  async getMeeting(u: CurrentUserContext, projectId: number, meetingId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const meeting = await this.loadMeeting(u.orgId, projectId, meetingId);
    const [attendees, actionItems, standupEntries] = await Promise.all([
      this.db
        .select({
          id: meetingAttendees.id,
          orgId: meetingAttendees.orgId,
          meetingId: meetingAttendees.meetingId,
          membershipId: meetingAttendees.membershipId,
          userId: organizationMembers.userId,
          attended: meetingAttendees.attended,
          createdAt: meetingAttendees.createdAt,
        })
        .from(meetingAttendees)
        .innerJoin(
          organizationMembers,
          and(
            eq(organizationMembers.id, meetingAttendees.membershipId),
            eq(organizationMembers.orgId, u.orgId),
          ),
        )
        .where(and(eq(meetingAttendees.meetingId, meetingId), eq(meetingAttendees.orgId, u.orgId)))
        .limit(100),
      this.db
        .select()
        .from(meetingActionItems)
        .where(
          and(
            eq(meetingActionItems.meetingId, meetingId),
            eq(meetingActionItems.orgId, u.orgId),
            isNull(meetingActionItems.deletedAt),
          ),
        )
        .limit(100),
      this.db
        .select()
        .from(meetingStandupEntries)
        .where(and(eq(meetingStandupEntries.meetingId, meetingId), eq(meetingStandupEntries.orgId, u.orgId)))
        .limit(100),
    ]);
    return { ...meeting, attendees, actionItems, standupEntries };
  }

  async createMeeting(u: CurrentUserContext, projectId: number, input: CreateMeetingInput) {
    await assertProjectWriteAccess(this.db, this.access, u, projectId);
    const resolvedCycleId = input.cycleId ?? null;
    let attendeeMemberships = new Map<string, number>();

    if (input.attendeeUserIds && input.attendeeUserIds.length > 0) {
      const members = await this.db
        .select({ userId: organizationMembers.userId, membershipId: projectMembers.membershipId })
        .from(projectMembers)
        .innerJoin(organizationMembers, and(eq(organizationMembers.orgId, projectMembers.orgId), eq(organizationMembers.id, projectMembers.membershipId)))
        .where(
          and(
            eq(projectMembers.projectId, projectId),
            inArray(organizationMembers.userId, input.attendeeUserIds),
          ),
        )
        .limit(100);
      const memberSet = new Set(members.map((m) => m.userId));
      attendeeMemberships = new Map(members.map((m) => [m.userId, m.membershipId]));
      const invalid = input.attendeeUserIds.filter((id) => !memberSet.has(id));
      if (invalid.length > 0) throw new BadRequestException(`Users are not project members: ${invalid.join(", ")}`);
    }

    const meeting = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${projectId})`);
      const [maxRow] = await tx
        .select({ maxNum: sql<number>`COALESCE(MAX(${projectMeetings.meetingNumber}), 0)` })
        .from(projectMeetings)
        .where(and(eq(projectMeetings.projectId, projectId), eq(projectMeetings.orgId, u.orgId)));
      const nextNumber = (maxRow?.maxNum ?? 0) + 1;
      const [created] = await tx
        .insert(projectMeetings)
        .values({
          orgId: u.orgId,
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
          cycleId: resolvedCycleId,
          createdBy: u.userId,
        })
        .returning();
      if (!created) throw new NotFoundException("Failed to create meeting");

      if (input.attendeeUserIds && input.attendeeUserIds.length > 0) {
        await tx.insert(meetingAttendees).values(
          input.attendeeUserIds.map((uid) => ({
            orgId: u.orgId,
            meetingId: created.id,
            membershipId: attendeeMemberships.get(uid) ?? 0,
          })),
        ).onConflictDoNothing();
      }

      return created;
    });

    this.audit.log({
      action: "meeting.created",
      userId: u.userId,
      orgId: u.orgId,
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
    if (input.cycleId !== undefined) patch.cycleId = input.cycleId ?? null;
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
      .select({ id: projectMembers.id, membershipId: projectMembers.membershipId })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.membershipId, sql`(SELECT id FROM organization_members WHERE org_id = ${orgId} AND user_id = ${input.userId} AND status = 'ACTIVE')`)))
      .limit(1);
    if (!member) throw new BadRequestException("User is not a project member");
    await this.db
      .insert(meetingAttendees)
      .values({
        orgId,
        meetingId,
        membershipId: member.membershipId,
      })
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
          sql`${meetingAttendees.membershipId} IN (SELECT id FROM organization_members WHERE org_id = ${orgId} AND user_id = ${attendeeUserId} AND status = 'ACTIVE')`,
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
