import { NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import { activities } from "../../../db/schema";
import { AuditService } from "../../../common/audit/audit.service";
import { auditActor, type ActivityActor } from "./activity-actor";
import type { UpdateActivityInput } from "../dto/activity.schemas";

/**
 * Changing an activity that already exists: edit it, complete it, delete it.
 *
 * Grouped because all three begin the same way — `requireActivity` reads the row
 * and 404s if it is missing or already deleted — and all three end by writing an
 * audit entry through the same actor mapping. Reading a timeline and creating an
 * activity share neither half, which is why they stay behind.
 *
 * A deps bag and free functions rather than a second `@Injectable`, the
 * `so-ship.ts` shape: the DI graph and every caller stay unchanged.
 */
export interface ActivityCommandDeps {
  readonly db: Db;
  readonly audit: AuditService;
}

export async function updateActivity(
  deps: ActivityCommandDeps,
  organizationId: string,
  activityId: string,
  actor: ActivityActor,
  input: UpdateActivityInput,
) {
  await requireActivity(deps, organizationId, activityId);

  const [row] = await deps.db
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
  deps.audit.log({
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
export async function completeActivity(
  deps: ActivityCommandDeps,
  organizationId: string,
  activityId: string,
  actor: ActivityActor,
) {
  const existing = await requireActivity(deps, organizationId, activityId);
  if (existing.kind !== "task") throw new NotFoundException("Task not found");

  const [row] = await deps.db
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
  deps.audit.log({
    action: "crm.activity.completed",
    userId: audited.userId,
    orgId: organizationId,
    resourceType: "activity",
    resourceId: activityId,
    metadata: audited.metadata,
  });

  return row ?? existing;
}

export async function removeActivity(
  deps: ActivityCommandDeps,
  organizationId: string,
  activityId: string,
  actor: ActivityActor,
) {
  await requireActivity(deps, organizationId, activityId);

  await deps.db
    .update(activities)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(activities.organizationId, organizationId),
        eq(activities.activityId, activityId),
      ),
    );

  const audited = auditActor(actor);
  deps.audit.log({
    action: "crm.activity.deleted",
    userId: audited.userId,
    orgId: organizationId,
    resourceType: "activity",
    resourceId: activityId,
    metadata: audited.metadata,
  });
}

/**
 * Re-asserts the organisation rather than leaning on row-level security.
 *
 * A cross-tenant identifier resolves to not-found, never forbidden — a 403 on
 * another organisation's id confirms the record exists.
 */
/**
 * Exported for `participants`, which is a READ and still has to 404 on an
 * activity that does not exist or is deleted — the same precondition the three
 * commands share, so it is the same function rather than a second copy.
 */
export async function requireActivity(
  deps: ActivityCommandDeps,
  organizationId: string,
  activityId: string,
) {
  const [row] = await deps.db
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
