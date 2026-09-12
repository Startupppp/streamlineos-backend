/**
 * Engagement transitions — update, cancel, terminate.
 *
 * These three are the write half of `WorkerEngagementsService`, and they share
 * a failure mode nothing else in that file has: each one is an optimistic
 * concurrent write. Every statement carries a status or `rowVersion` predicate
 * in its WHERE, and a zero-row result is read as "somebody else changed this",
 * not as "not found". The worker-facet reads next door — list, get, create —
 * have no version to lose.
 *
 * `loadEngagement` is deliberately NOT exported: it was private on the service
 * and it returns a whole engagement row. The reference guard the update path
 * runs before writing lives in ./engagement-references.
 */
import { ConflictException, NotFoundException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { AuditService } from "../../../common/audit/audit.service";
import type { Db } from "../../../db/drizzle.module";
import { workerEngagements } from "../../../db/schema/directory";
import type {
  TerminateEngagementInput,
  UpdateEngagementInput,
} from "../dto/directory.schemas";
import {
  assertValidEngagementPeriod,
  ENGAGEMENT_ERROR,
  throwEngagementWriteError,
} from "../worker-engagement-errors";
import { assertUpdateReferences } from "./engagement-references";

export interface EngagementTransitionDeps {
  readonly db: Db;
  readonly audit: AuditService;
}

export type EngagementRow = typeof workerEngagements.$inferSelect;
type EngagementPatch = Partial<typeof workerEngagements.$inferInsert>;

async function loadEngagement(
  deps: EngagementTransitionDeps,
  organizationId: string,
  workerEngagementId: string,
): Promise<EngagementRow> {
  const [row] = await deps.db
    .select()
    .from(workerEngagements)
    .where(
      and(
        eq(workerEngagements.workerEngagementId, workerEngagementId),
        eq(workerEngagements.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundException("Engagement not found");
  return row;
}

export async function updateEngagement(
  deps: EngagementTransitionDeps,
  organizationId: string,
  userId: string,
  workerEngagementId: string,
  input: UpdateEngagementInput,
) {
  const existing = await loadEngagement(deps, organizationId, workerEngagementId);
  assertValidEngagementPeriod(
    input.startsOn ?? existing.startsOn,
    input.endsOn === undefined ? existing.endsOn : input.endsOn,
  );
  await assertUpdateReferences(
    deps,
    organizationId,
    workerEngagementId,
    existing.workerId,
    input,
  );

  const patch: EngagementPatch = {};
  if (input.startsOn !== undefined) patch.startsOn = input.startsOn;
  if (input.endsOn !== undefined) patch.endsOn = input.endsOn ?? null;
  if (input.workerType !== undefined) patch.workerType = input.workerType;
  if (input.isPrimary !== undefined) patch.isPrimary = input.isPrimary;
  if (input.designation !== undefined) patch.designation = input.designation ?? null;
  if (input.departmentId !== undefined) patch.departmentId = input.departmentId ?? null;
  if (input.businessUnitId !== undefined) patch.businessUnitId = input.businessUnitId ?? null;
  if (input.branchId !== undefined) patch.branchId = input.branchId ?? null;
  if (input.locationId !== undefined) patch.locationId = input.locationId ?? null;
  if (input.teamId !== undefined) patch.teamId = input.teamId ?? null;
  if (input.managerEngagementId !== undefined) {
    patch.managerEngagementId = input.managerEngagementId ?? null;
  }
  if (input.jobRoleId !== undefined) patch.jobRoleId = input.jobRoleId ?? null;
  if (input.jobLevelId !== undefined) patch.jobLevelId = input.jobLevelId ?? null;
  if (input.employmentTypeId !== undefined) {
    patch.employmentTypeId = input.employmentTypeId ?? null;
  }
  if (input.probationEndsOn !== undefined) patch.probationEndsOn = input.probationEndsOn ?? null;
  if (input.noticePeriodDays !== undefined) patch.noticePeriodDays = input.noticePeriodDays ?? null;
  const [updated] = await deps.db
    .update(workerEngagements)
    .set({
      ...patch,
      rowVersion: sql`${workerEngagements.rowVersion} + 1`,
    })
    .where(
      and(
        eq(workerEngagements.workerEngagementId, workerEngagementId),
        eq(workerEngagements.organizationId, organizationId),
        eq(workerEngagements.rowVersion, input.expectedVersion),
      ),
    )
    .returning()
    .catch(throwEngagementWriteError);
  if (!updated) {
    throw new ConflictException({
      code: ENGAGEMENT_ERROR.STALE,
      message: "This engagement changed while you were viewing it. Refresh and try again.",
    });
  }
  await deps.audit.logCritical({
    action: "directory.engagement.updated",
    userId,
    orgId: organizationId,
    resourceType: "worker_engagement",
    resourceId: workerEngagementId,
    metadata: { workerEngagementId },
  });
  return updated;
}

export async function cancelEngagement(
  deps: EngagementTransitionDeps,
  organizationId: string,
  userId: string,
  workerEngagementId: string,
) {
  const existing = await loadEngagement(deps, organizationId, workerEngagementId);
  if (existing.status === "CANCELLED") return existing;
  if (existing.status !== "PLANNED") {
    throw new ConflictException({
      code: ENGAGEMENT_ERROR.NOT_PLANNED,
      message: "Only a planned engagement can be cancelled. End an active engagement instead.",
    });
  }
  const [updated] = await deps.db
    .update(workerEngagements)
    .set({ status: "CANCELLED", isPrimary: false })
    .where(
      and(
        eq(workerEngagements.workerEngagementId, workerEngagementId),
        eq(workerEngagements.organizationId, organizationId),
        eq(workerEngagements.status, "PLANNED"),
      ),
    )
    .returning();
  if (!updated) {
    throw new ConflictException({
      code: ENGAGEMENT_ERROR.NOT_PLANNED,
      message: "This engagement changed while you were viewing it. Refresh and try again.",
    });
  }
  await deps.audit.logCritical({
    action: "directory.engagement.cancelled",
    userId,
    orgId: organizationId,
    resourceType: "worker_engagement",
    resourceId: workerEngagementId,
    metadata: { workerEngagementId },
  });
  return updated;
}

export async function terminateEngagement(
  deps: EngagementTransitionDeps,
  organizationId: string,
  userId: string,
  workerEngagementId: string,
  input: TerminateEngagementInput,
) {
  const existing = await loadEngagement(deps, organizationId, workerEngagementId);
  if (existing.status !== "ACTIVE") {
    throw new ConflictException({
      code: ENGAGEMENT_ERROR.NOT_ACTIVE,
      message: "Only an active engagement can be terminated.",
    });
  }
  assertValidEngagementPeriod(existing.startsOn, input.endsOn ?? existing.endsOn);
  const [updated] = await deps.db
    .update(workerEngagements)
    .set({
      status: "TERMINATED",
      endsOn: input.endsOn ?? existing.endsOn,
      terminationReason: input.terminationReason ?? null,
      terminationNotes: input.terminationNotes ?? null,
      isPrimary: false,
      rowVersion: sql`${workerEngagements.rowVersion} + 1`,
    })
    .where(
      and(
        eq(workerEngagements.workerEngagementId, workerEngagementId),
        eq(workerEngagements.organizationId, organizationId),
        eq(workerEngagements.status, "ACTIVE"),
        eq(workerEngagements.rowVersion, input.expectedVersion),
      ),
    )
    .returning();
  if (!updated) {
    throw new ConflictException({
      code: ENGAGEMENT_ERROR.STALE,
      message: "This engagement changed while you were viewing it. Refresh and try again.",
    });
  }
  await deps.audit.logCritical({
    action: "directory.engagement.terminated",
    userId,
    orgId: organizationId,
    resourceType: "worker_engagement",
    resourceId: workerEngagementId,
    metadata: { workerEngagementId, terminationReason: input.terminationReason },
  });
  return updated;
}
