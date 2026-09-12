/**
 * Everything an engagement patch may point at must be live and in the CALLER's
 * organization.
 *
 * A patch names an org unit, a manager engagement, a job role and a job level
 * by id, and an id is not evidence of ownership. This guard re-asserts
 * `organizationId` on every one of those lookups rather than leaning on RLS, so
 * a reference to another tenant's department or job role fails here instead of
 * being written and becoming visible later. It also rejects the two shapes that
 * are wrong regardless of tenancy: an engagement managing itself, and a worker
 * managing themselves through a second engagement.
 *
 * It lives beside the transitions rather than inside them because it is the
 * whole of the "is this patch allowed to reference that" question, and it has
 * to be mutable-in-isolation for a test to prove it still fires.
 */
import { BadRequestException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { assertActiveOrgUnit } from "../../../common/org/sync-org-unit-placement";
import type { Db } from "../../../db/drizzle.module";
import { workerEngagements } from "../../../db/schema/directory";
import { hrJobLevels, hrJobRoles } from "../../../db/schema/hr/core-org";
import type { UpdateEngagementInput } from "../dto/directory.schemas";

export interface EngagementReferenceDeps {
  readonly db: Db;
}

export async function assertUpdateReferences(
  deps: EngagementReferenceDeps,
  organizationId: string,
  workerEngagementId: string,
  workerId: string,
  input: UpdateEngagementInput,
): Promise<void> {
  const unitChecks = [
    ["BUSINESS_UNIT", input.businessUnitId],
    ["BRANCH", input.branchId],
    ["DEPARTMENT", input.departmentId],
    ["TEAM", input.teamId],
    ["LOCATION", input.locationId],
  ] as const;
  await Promise.all(
    unitChecks.map(([unitKind, orgUnitId]) =>
      orgUnitId === undefined || orgUnitId === null
        ? Promise.resolve()
        : assertActiveOrgUnit(deps.db, organizationId, orgUnitId, unitKind),
    ),
  );

  if (input.employmentTypeId !== undefined && input.employmentTypeId !== null) {
    throw new BadRequestException(
      "Employment type IDs are not supported by the current catalog. Use workerType instead.",
    );
  }
  if (input.managerEngagementId !== undefined && input.managerEngagementId !== null) {
    if (input.managerEngagementId === workerEngagementId) {
      throw new BadRequestException("An engagement cannot manage itself.");
    }
    const [manager] = await deps.db
      .select({ workerId: workerEngagements.workerId })
      .from(workerEngagements)
      .where(
        and(
          eq(workerEngagements.organizationId, organizationId),
          eq(workerEngagements.workerEngagementId, input.managerEngagementId),
          eq(workerEngagements.status, "ACTIVE"),
          isNull(workerEngagements.archivedAt),
        ),
      )
      .limit(1);
    if (!manager || manager.workerId === workerId) {
      throw new BadRequestException("Invalid manager engagement selection.");
    }
  }
  if (input.jobRoleId !== undefined && input.jobRoleId !== null) {
    const [role] = await deps.db
      .select({ id: hrJobRoles.id })
      .from(hrJobRoles)
      .where(
        and(
          eq(hrJobRoles.id, input.jobRoleId),
          eq(hrJobRoles.orgId, organizationId),
          eq(hrJobRoles.isActive, true),
        ),
      )
      .limit(1);
    if (!role) throw new BadRequestException("Invalid job role selection.");
  }
  if (input.jobLevelId !== undefined && input.jobLevelId !== null) {
    const [level] = await deps.db
      .select({ id: hrJobLevels.id })
      .from(hrJobLevels)
      .where(
        and(
          eq(hrJobLevels.id, input.jobLevelId),
          eq(hrJobLevels.orgId, organizationId),
          eq(hrJobLevels.isActive, true),
        ),
      )
      .limit(1);
    if (!level) throw new BadRequestException("Invalid job level selection.");
  }
}
