import type { Db } from "../../../db/drizzle.module";
import { hrEmployeeSensitiveFields } from "../../../db/schema";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { sealSensitive } from "../../../common/security/sensitive-field";
import { sealBankDetails } from "../../../common/hr/canonical-bank-details";
import { monthlyAmountToCents } from "../../../common/hr/sync-canonical-sensitive-fields";
import type { ReportingRelationshipService } from "../../directory/reporting-relationship.service";
import type { ManagerResolution, ReportingManagerFallbackResolver } from "../../directory/reporting-manager-fallback.resolver";
import { ReportingLineException } from "../../directory/reporting-line-errors";
import { REPORTING_LINE_ERROR_CODES } from "../../directory/reporting-line.types";
import { orgBusinessDate } from "../time/attendance-business-date";
import { toBankDetails } from "./bulk-onboarding/bulk-onboarding-bank-details";
import type { OnboardEmployeeInput } from "./dto/hr-directory.schemas";

export async function writeOnboardingSensitiveFields(
  tx: DbOrTx,
  orgId: string,
  employmentId: number,
  body: OnboardEmployeeInput,
  salaryCurrency: string | null,
): Promise<void> {
  if (!body.taxId && !body.bankDetails?.accountNumber && body.monthlySalary === undefined) return;
  const sensitiveSet: Partial<typeof hrEmployeeSensitiveFields.$inferInsert> = {};
  if (body.monthlySalary !== undefined && salaryCurrency) {
    sensitiveSet.salaryAmountCents = monthlyAmountToCents(body.monthlySalary);
    sensitiveSet.salaryCurrency = salaryCurrency;
    sensitiveSet.salaryFrequency = "MONTHLY";
  }
  if (body.taxId) sensitiveSet.taxId = sealSensitive(body.taxId);
  if (body.bankDetails?.accountNumber) sensitiveSet.bankDetails = sealBankDetails(toBankDetails(body.bankDetails));
  await tx
    .insert(hrEmployeeSensitiveFields)
    .values({ orgId, employmentId, ...sensitiveSet })
    .onConflictDoUpdate({ target: hrEmployeeSensitiveFields.employmentId, set: { ...sensitiveSet, updatedAt: new Date() } });
}

export interface OnboardingManagerDeps {
  db: Db;
  relationships: Pick<ReportingRelationshipService, "setRelationships">;
  fallback: Pick<ReportingManagerFallbackResolver, "resolve">;
}

export interface OnboardingPrimaryManager {
  userId: string;
  name: string;
  resolution: ManagerResolution;
}

/**
 * HRM-15 D2/D3: a named manager is used as given; a top-level role records its reason; otherwise
 * the policy picks the fallback, and no eligible fallback refuses the whole onboarding.
 */
export async function assignOnboardingManager(
  deps: OnboardingManagerDeps,
  tx: DbOrTx,
  actor: CurrentUserContext,
  input: { employeeUserId: string; body: OnboardEmployeeInput; joiningDate: string | null },
): Promise<OnboardingPrimaryManager | null> {
  const { employeeUserId, body } = input;
  const effectiveFrom = input.joiningDate ?? (await orgBusinessDate(deps.db, actor.orgId));
  if (body.topLevelRole) {
    await deps.relationships.setRelationships(tx, {
      orgId: actor.orgId,
      actor,
      subjectUserId: employeeUserId,
      primaryManagerUserId: null,
      topLevelReason: body.topLevelRoleReason ?? null,
      effectiveFrom,
      source: "ONBOARDING_SELECTED",
    });
    return null;
  }
  const resolved = await deps.fallback.resolve(
    actor.orgId,
    actor,
    { key: 1, employeeUserId, employeeEmail: body.email, primaryManagerUserId: body.reportingManagerUserId ?? null },
    tx,
  );
  if (!resolved.ok) throw new ReportingLineException(resolved.code, resolved.message);
  if (!resolved.managerUserId)
    throw new ReportingLineException(REPORTING_LINE_ERROR_CODES.MANAGER_NOT_FOUND, "The reporting manager could not be resolved.");
  await deps.relationships.setRelationships(tx, {
    orgId: actor.orgId,
    actor,
    subjectUserId: employeeUserId,
    primaryManagerUserId: resolved.managerUserId,
    secondary: body.secondaryManagers?.map((entry) => ({ managerUserId: entry.managerUserId, label: entry.label ?? null })),
    effectiveFrom,
    source: resolved.resolution === "SELECTED" ? "ONBOARDING_SELECTED" : "ONBOARDING_FALLBACK",
  });
  return {
    userId: resolved.managerUserId,
    name: resolved.name ?? resolved.email ?? resolved.managerUserId,
    resolution: resolved.resolution,
  };
}
