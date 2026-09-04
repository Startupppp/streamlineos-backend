import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import { hasCompatibleHolidays } from "../../../../db/compat/organization-holidays";
import {
  documentTypes,
  hiringFlows,
  hrJobRoles,
  orgUnits,
  hrPositions,
  hrWorkflowDefinitions,
  leavePolicies,
  offerLetterTemplates,
  onboardingTemplates,
  organizationMembers,
  organizations,
  payrollPolicies,
  salaryComponents,
  scorecardTemplates,
  shiftTemplates,
} from "../../../../db/schema";

/**
 * The HR setup signals: one boolean per checklist item, each derived from real HR
 * data rather than a manual "mark complete" click.
 *
 * These probes are the half that changes when HR gains a setup surface — a new
 * table, a new "is it configured yet" question. `HrChecklistReconciliationService`
 * is the half that changes when the checklist's write behaviour does. Keeping the
 * probes here also means they can be exercised against a database double without
 * constructing the Nest provider.
 */

export const HR_SIGNAL_KEYS = [
  "org_profile",
  "locations_departments",
  "roles_positions",
  "leave_policies",
  "holiday_calendar",
  "attendance_schedule",
  "onboarding_template",
  "document_types",
  "approval_workflows",
  "payroll_setup",
  "recruitment_setup",
  "first_employees",
] as const;

export type HrSignalKey = (typeof HR_SIGNAL_KEYS)[number];
export type HrSignals = Record<HrSignalKey, boolean>;

async function hasAny(query: PromiseLike<unknown[]>): Promise<boolean> {
  return (await query).length > 0;
}

export async function computeHrSignals(db: Db, orgId: string): Promise<HrSignals> {
  const [
    org,
    hasDepartments,
    hasLocations,
    hasJobRoles,
    hasPositions,
    hasLeavePolicies,
    hasHolidays,
    hasShifts,
    hasOnboardingTemplates,
    hasDocumentTypes,
    hasWorkflows,
    hasSalaryComponents,
    hasPayrollPolicies,
    hasHiringFlows,
    hasScorecardTemplates,
    hasOfferTemplates,
    hasEmployees,
  ] = await Promise.all([
    db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
      columns: { name: true, country: true, timezone: true },
    }),
    hasAny(
      db
        .select({ one: sql`1` })
        .from(orgUnits)
        .where(
          and(
            eq(orgUnits.orgId, orgId),
            eq(orgUnits.kind, "DEPARTMENT"),
            isNull(orgUnits.deletedAt),
          ),
        )
        .limit(1),
    ),
    hasAny(
      db
        .select({ one: sql`1` })
        .from(orgUnits)
        .where(
          and(
            eq(orgUnits.orgId, orgId),
            eq(orgUnits.kind, "LOCATION"),
            isNull(orgUnits.deletedAt),
          ),
        )
        .limit(1),
    ),
    hasAny(
      db
        .select({ one: sql`1` })
        .from(hrJobRoles)
        .where(
          and(eq(hrJobRoles.orgId, orgId), eq(hrJobRoles.isActive, true)),
        )
        .limit(1),
    ),
    hasAny(
      db
        .select({ one: sql`1` })
        .from(hrPositions)
        .where(
          and(eq(hrPositions.orgId, orgId), isNull(hrPositions.deletedAt)),
        )
        .limit(1),
    ),
    hasAny(
      db
        .select({ one: sql`1` })
        .from(leavePolicies)
        .where(
          and(
            eq(leavePolicies.orgId, orgId),
            eq(leavePolicies.isActive, true),
          ),
        )
        .limit(1),
    ),
    hasCompatibleHolidays(db, orgId),
    hasAny(
      db
        .select({ one: sql`1` })
        .from(shiftTemplates)
        .where(
          and(
            eq(shiftTemplates.orgId, orgId),
            eq(shiftTemplates.isActive, true),
          ),
        )
        .limit(1),
    ),
    hasAny(
      db
        .select({ one: sql`1` })
        .from(onboardingTemplates)
        .where(
          and(
            eq(onboardingTemplates.orgId, orgId),
            eq(onboardingTemplates.isActive, true),
          ),
        )
        .limit(1),
    ),
    hasAny(
      db
        .select({ one: sql`1` })
        .from(documentTypes)
        .where(
          and(
            eq(documentTypes.orgId, orgId),
            eq(documentTypes.isActive, true),
          ),
        )
        .limit(1),
    ),
    hasAny(
      db
        .select({ one: sql`1` })
        .from(hrWorkflowDefinitions)
        .where(
          and(
            eq(hrWorkflowDefinitions.orgId, orgId),
            eq(hrWorkflowDefinitions.status, "active"),
            isNull(hrWorkflowDefinitions.deletedAt),
          ),
        )
        .limit(1),
    ),
    hasAny(
      db
        .select({ one: sql`1` })
        .from(salaryComponents)
        .where(
          and(
            eq(salaryComponents.orgId, orgId),
            eq(salaryComponents.isActive, true),
          ),
        )
        .limit(1),
    ),
    hasAny(
      db
        .select({ one: sql`1` })
        .from(payrollPolicies)
        .where(
          and(
            eq(payrollPolicies.orgId, orgId),
            eq(payrollPolicies.status, "ACTIVE"),
          ),
        )
        .limit(1),
    ),
    hasAny(
      db
        .select({ one: sql`1` })
        .from(hiringFlows)
        .where(eq(hiringFlows.orgId, orgId))
        .limit(1),
    ),
    hasAny(
      db
        .select({ one: sql`1` })
        .from(scorecardTemplates)
        .where(
          and(
            eq(scorecardTemplates.orgId, orgId),
            eq(scorecardTemplates.isActive, true),
          ),
        )
        .limit(1),
    ),
    hasAny(
      db
        .select({ one: sql`1` })
        .from(offerLetterTemplates)
        .where(eq(offerLetterTemplates.orgId, orgId))
        .limit(1),
    ),
    hasAny(
      db
        .select({ one: sql`1` })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.isOwner, false),
          ),
        )
        .limit(1),
    ),
  ]);

  return {
    org_profile: Boolean(org?.name && org.country && org.timezone),
    locations_departments: hasDepartments && hasLocations,
    roles_positions: hasJobRoles && hasPositions,
    leave_policies: hasLeavePolicies,
    holiday_calendar: hasHolidays,
    attendance_schedule: hasShifts,
    onboarding_template: hasOnboardingTemplates,
    document_types: hasDocumentTypes,
    approval_workflows: hasWorkflows,
    payroll_setup: hasSalaryComponents && hasPayrollPolicies,
    recruitment_setup:
      hasHiringFlows || hasScorecardTemplates || hasOfferTemplates,
    first_employees: hasEmployees,
  };
}
