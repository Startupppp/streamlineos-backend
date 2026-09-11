import { Inject, Injectable, Optional } from "@nestjs/common";
import { and, desc, eq, isNull, type SQL } from "drizzle-orm";
import { keysetBefore } from "../../common/pagination/keyset";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { activities, activityParticipants, users } from "../../db/schema";
import { AuditService } from "../../common/audit/audit.service";
import { RelationshipStateService } from "../relationships/relationship-state.service";
import {
  buildTimelinePage,
  decodeTimelineCursor,
  type TimelineEntry,
  type TimelinePage,
} from "./activity-timeline";
import { type ActivityActor } from "./lib/activity-actor";
export type { ActivityActor } from "./lib/activity-actor";
import {
  completeActivity,
  removeActivity,
  requireActivity,
  updateActivity,
  type ActivityCommandDeps,
} from "./lib/activity-commands";
import type {
  CreateActivityInput,
  TimelineQuery,
  UpdateActivityInput,
} from "./dto/activity.schemas";

@Injectable()
export class ActivitiesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    /**
     * Optional, for the reason the ingress seam takes its own collaborators
     * optionally: recording what happened must not depend on the thing that
     * summarises it. A relationship state one activity behind is repaired by the
     * next activity or by a rebuild; an activity refused because a derived table
     * could not be written is a lost record of something that happened.
     */
    @Optional() private readonly relationships?: RelationshipStateService,
  ) {}

  /**
   * One chronological timeline, whatever the anchor.
   *
   * There is exactly one query here rather than one per anchor kind, because a
   * party timeline and a deal timeline differing in behaviour is precisely the
   * drift that produced six of these already.
   */
  async timeline(organizationId: string, query: TimelineQuery): Promise<TimelinePage> {
    const position = decodeTimelineCursor(query.cursor);

    const anchor = query.partyId
      ? eq(activities.partyId, query.partyId)
      : query.dealId
        ? eq(activities.dealId, query.dealId)
        : eq(activities.subjectId, query.subjectId ?? "");

    const conditions: (SQL | undefined)[] = [
      eq(activities.organizationId, organizationId),
      isNull(activities.deletedAt),
      anchor,
      query.kind ? eq(activities.kind, query.kind) : undefined,
      // Keyset on both columns: timestamps collide, so ordering on occurred_at
      // alone skips or repeats rows at every page boundary.
      position
        ? keysetBefore(activities.occurredAt, activities.activityId, { sortValue: position.occurredAt, id: position.activityId })
        : undefined,
    ];

    const rows = await this.db
      .select({
        activityId: activities.activityId,
        kind: activities.kind,
        occurredAt: activities.occurredAt,
        subject: activities.subject,
        body: activities.body,
        threadId: activities.threadId,
        actorKind: activities.actorKind,
        actorLabel: activities.actorLabel,
        actorName: users.name,
        dueAt: activities.dueAt,
        completedAt: activities.completedAt,
        source: activities.source,
      })
      .from(activities)
      .leftJoin(users, eq(users.id, activities.actorUserId))
      .where(and(...conditions))
      .orderBy(desc(activities.occurredAt), desc(activities.activityId))
      .limit(query.limit + 1);

    return buildTimelinePage(rows as TimelineEntry[], query.limit);
  }

  /** A person's own tasks — the same rows the timeline shows, read by assignee. */
  /**
   * The same rows the timeline shows, read by assignee instead of by anchor —
   * and read in a different order, because it answers a different question.
   *
   * Soonest first, undated last. A task list ordered by when each row was
   * written puts this morning's note above last week's overdue call, which
   * buries exactly the row the screen exists to surface; it also walks past
   * `idx_activities_assignee_open`, which the schema declares on `due_at`.
   *
   * The anchor rides along because "Follow up" with no customer beside it is not
   * actionable. Three left joins rather than a lookup per row: the page is
   * bounded at 100, and N+1 on a screen someone opens every morning is the
   * kind of slow that never gets attributed to the query that caused it.
   */
  async create(
    organizationId: string,
    actor: ActivityActor,
    input: CreateActivityInput,
    source = "manual",
  ) {
    const created = await this.db.transaction(async (tx) => {
      const [row] = await (tx as Db)
        .insert(activities)
        .values({
          organizationId,
          kind: input.kind,
          occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
          subject: input.subject ?? null,
          body: input.body ?? null,
          threadId: input.threadId ?? null,
          partyId: input.partyId ?? null,
          dealId: input.dealId ?? null,
          subjectId: input.subjectId ?? null,
          actorKind: actor.kind,
          actorUserId: actor.kind === "human" ? actor.userId : null,
          actorLabel: actor.kind === "system" ? actor.label : null,
          dueAt: input.dueAt ? new Date(input.dueAt) : null,
          assigneeUserId: input.assigneeUserId ?? null,
          source,
        })
        .returning();

      if (row && input.participants.length > 0)
        await (tx as Db).insert(activityParticipants).values(
          input.participants.map((participant) => ({
            organizationId,
            activityId: row.activityId,
            partyId: participant.partyId ?? null,
            userId: participant.userId ?? null,
            address: participant.address ?? null,
            role: participant.role,
          })),
        );

      return row;
    });

    await this.materialise(organizationId, created?.activityId);
    return created;
  }

  /**
   * The materialisation, after the write it derives from.
   *
   * Ticket 01's fourth criterion is that the relationship state moves when an
   * activity arrives rather than waiting for a sweep, and this is the half of
   * that which is not the ingress seam — an activity typed into the CRM by a rep
   * changes what the relationship looks like exactly as much as one that
   * arrived through an adapter.
   *
   * Outside the transaction on purpose. It reads the row it is summarising, so
   * inside it would be reading its own uncommitted write on a handle the fold
   * has no business holding; and by the platform's own rule, work that must not
   * fail the request does not share the request's transaction.
   */
  private async materialise(organizationId: string, activityId: string | undefined): Promise<void> {
    if (!activityId || !this.relationships) return;
    await this.relationships.tryOnActivity(organizationId, activityId);
  }

  /** Everyone who was on it, resolved so no caller renders an identifier. */
  /** @see lib/activity-commands.ts */
  async update(
    organizationId: string,
    activityId: string,
    actor: ActivityActor,
    input: UpdateActivityInput,
  ) {
    return updateActivity(this.commandDeps, organizationId, activityId, actor, input);
  }

  /** @see lib/activity-commands.ts */
  async complete(organizationId: string, activityId: string, actor: ActivityActor) {
    return completeActivity(this.commandDeps, organizationId, activityId, actor);
  }

  /** @see lib/activity-commands.ts */
  async remove(organizationId: string, activityId: string, actor: ActivityActor) {
    return removeActivity(this.commandDeps, organizationId, activityId, actor);
  }

  private get commandDeps(): ActivityCommandDeps {
    return {
      db: this.db,
      audit: this.audit,
      materialise: (organizationId, activityId) => this.materialise(organizationId, activityId),
    };
  }

  async participants(organizationId: string, activityId: string) {
    await requireActivity(this.commandDeps, organizationId, activityId);

    return this.db
      .select({
        activityParticipantId: activityParticipants.activityParticipantId,
        partyId: activityParticipants.partyId,
        userId: activityParticipants.userId,
        userName: users.name,
        address: activityParticipants.address,
        role: activityParticipants.role,
      })
      .from(activityParticipants)
      .leftJoin(users, eq(users.id, activityParticipants.userId))
      .where(
        and(
          eq(activityParticipants.organizationId, organizationId),
          eq(activityParticipants.activityId, activityId),
        ),
      )
      .limit(100);
  }

}
