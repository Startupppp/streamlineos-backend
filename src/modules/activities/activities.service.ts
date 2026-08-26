import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull, type SQL } from "drizzle-orm";
import { keysetBefore } from "../../common/pagination/keyset";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { activities, activityParticipants, users } from "../../db/schema";
import { AuditService } from "../../common/audit/audit.service";
import {
  buildTimelinePage,
  decodeTimelineCursor,
  type TimelineEntry,
  type TimelinePage,
} from "./activity-timeline";
import type {
  CreateActivityInput,
  TimelineQuery,
  UpdateActivityInput,
} from "./dto/activity.schemas";

/**
 * Who or what recorded an activity.
 *
 * The same union the deal ledger uses, for the same reason: ticket 10's ingress
 * and ticket 12's extraction both write activities nobody typed, and a reader
 * has to be able to tell.
 */
export type ActivityActor =
  | { readonly kind: "human"; readonly userId: string }
  | { readonly kind: "system"; readonly label: string };

/**
 * `audit_logs.user_id` is NOT NULL, and the repo already writes this sentinel
 * for machine actions (recurring journals, KB page tree, the git integration).
 * The label that says WHICH system did it rides in the entry's metadata, and the
 * activity row itself keeps `actor_label` — this is only the audit column.
 */
const SYSTEM_AUDIT_USER = "system";

function auditActor(actor: ActivityActor): { userId: string; metadata: Record<string, unknown> } {
  return actor.kind === "human"
    ? { userId: actor.userId, metadata: {} }
    : { userId: SYSTEM_AUDIT_USER, metadata: { actorLabel: actor.label } };
}

@Injectable()
export class ActivitiesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
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
    return this.db.transaction(async (tx) => {
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
  }

  async update(
    organizationId: string,
    activityId: string,
    actor: ActivityActor,
    input: UpdateActivityInput,
  ) {
    await this.require(organizationId, activityId);

    const [row] = await this.db
      .update(activities)
      .set({
        ...(input.subject === undefined ? {} : { subject: input.subject ?? null }),
        ...(input.body === undefined ? {} : { body: input.body ?? null }),
        ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt ? new Date(input.dueAt) : null }),
        ...(input.assigneeUserId === undefined
          ? {}
          : { assigneeUserId: input.assigneeUserId ?? null }),
      })
      .where(
        and(
          eq(activities.organizationId, organizationId),
          eq(activities.activityId, activityId),
        ),
      )
      .returning();

    const audited = auditActor(actor);
    this.audit.log({
      action: "crm.activity.updated",
      userId: audited.userId,
      orgId: organizationId,
      resourceType: "activity",
      resourceId: activityId,
      metadata: { ...audited.metadata, changed: Object.keys(input) },
    });

    return row;
  }

  /** Completion is a timestamp, not a boolean — when it happened is the fact. */
  async complete(organizationId: string, activityId: string, actor: ActivityActor) {
    const existing = await this.require(organizationId, activityId);
    if (existing.kind !== "task") throw new NotFoundException("Task not found");

    const [row] = await this.db
      .update(activities)
      .set({ completedAt: new Date() })
      .where(
        and(
          eq(activities.organizationId, organizationId),
          eq(activities.activityId, activityId),
          isNull(activities.completedAt),
        ),
      )
      .returning();

    const audited = auditActor(actor);
    this.audit.log({
      action: "crm.activity.completed",
      userId: audited.userId,
      orgId: organizationId,
      resourceType: "activity",
      resourceId: activityId,
      metadata: audited.metadata,
    });

    return row ?? existing;
  }

  async remove(organizationId: string, activityId: string, actor: ActivityActor) {
    await this.require(organizationId, activityId);

    await this.db
      .update(activities)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(activities.organizationId, organizationId),
          eq(activities.activityId, activityId),
        ),
      );

    const audited = auditActor(actor);
    this.audit.log({
      action: "crm.activity.deleted",
      userId: audited.userId,
      orgId: organizationId,
      resourceType: "activity",
      resourceId: activityId,
      metadata: audited.metadata,
    });
  }

  /** Everyone who was on it, resolved so no caller renders an identifier. */
  async participants(organizationId: string, activityId: string) {
    await this.require(organizationId, activityId);

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

  /**
   * Re-asserts the organisation rather than leaning on row-level security.
   *
   * A cross-tenant identifier resolves to not-found, never forbidden — a 403 on
   * another organisation's id confirms the record exists.
   */
  private async require(organizationId: string, activityId: string) {
    const [row] = await this.db
      .select()
      .from(activities)
      .where(
        and(
          eq(activities.organizationId, organizationId),
          eq(activities.activityId, activityId),
          isNull(activities.deletedAt),
        ),
      )
      .limit(1);

    if (!row) throw new NotFoundException("Activity not found");
    return row;
  }
}
