import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
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
  moduleSetupChecklistItems,
  offerLetterTemplates,
  onboardingTemplates,
  organizationMembers,
  organizations,
  payrollPolicies,
  salaryComponents,
  scorecardTemplates,
  shiftTemplates,
} from "../../../../db/schema";

type ChecklistItemRow = typeof moduleSetupChecklistItems.$inferSelect;

const HR_SIGNAL_KEYS = [
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

type HrSignalKey = (typeof HR_SIGNAL_KEYS)[number];
type HrSignals = Record<HrSignalKey, boolean>;

/**
 * Derives HR setup-checklist item completion from real HR data instead of manual complete
 * clicks (task requirement: "completion should be calculated from real data"). Called by
 * ModuleChecklistService on every HR checklist read.
 */
@Injectable()
export class HrChecklistReconciliationService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** Applies auto-detected status to every non-skipped, non-blocked item. Returns true if anything changed. */
  async reconcile(orgId: string, items: ChecklistItemRow[]): Promise<boolean> {
    const signals = await this.computeSignals(orgId);
    const nowDone: number[] = [];
    const nowTodo: number[] = [];

    for (const item of items) {
      if (!this.isHrSignalKey(item.itemKey)) continue;
      if (item.status === "skipped" || item.status === "blocked") continue;

      const satisfied = signals[item.itemKey];
      if (satisfied && item.status !== "done") nowDone.push(item.id);
      else if (!satisfied && item.status === "done") nowTodo.push(item.id);
    }

    if (nowDone.length > 0) {
      await this.db
        .update(moduleSetupChecklistItems)
        .set({ status: "done", completedAt: new Date() })
        .where(
          and(
            eq(moduleSetupChecklistItems.orgId, orgId),
            inArray(moduleSetupChecklistItems.id, nowDone),
          ),
        );
    }

    if (nowTodo.length > 0) {
      await this.db
        .update(moduleSetupChecklistItems)
        .set({ status: "todo", completedAt: null })
        .where(
          and(
            eq(moduleSetupChecklistItems.orgId, orgId),
            inArray(moduleSetupChecklistItems.id, nowTodo),
          ),
        );
    }

    return nowDone.length > 0 || nowTodo.length > 0;
  }

  private isHrSignalKey(itemKey: string): itemKey is HrSignalKey {
    return (HR_SIGNAL_KEYS as readonly string[]).includes(itemKey);
  }

  private async computeSignals(orgId: string): Promise<HrSignals> {
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
      this.db.query.organizations.findFirst({
        where: eq(organizations.id, orgId),
        columns: { name: true, country: true, timezone: true },
      }),
      this.any(
        this.db
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
      this.any(
        this.db
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
      this.any(
        this.db
          .select({ one: sql`1` })
          .from(hrJobRoles)
          .where(
            and(eq(hrJobRoles.orgId, orgId), eq(hrJobRoles.isActive, true)),
          )
          .limit(1),
      ),
      this.any(
        this.db
          .select({ one: sql`1` })
          .from(hrPositions)
          .where(
            and(eq(hrPositions.orgId, orgId), isNull(hrPositions.deletedAt)),
          )
          .limit(1),
      ),
      this.any(
        this.db
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
      hasCompatibleHolidays(this.db, orgId),
      this.any(
        this.db
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
      this.any(
        this.db
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
      this.any(
        this.db
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
      this.any(
        this.db
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
      this.any(
        this.db
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
      this.any(
        this.db
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
      this.any(
        this.db
          .select({ one: sql`1` })
          .from(hiringFlows)
          .where(eq(hiringFlows.orgId, orgId))
          .limit(1),
      ),
      this.any(
        this.db
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
      this.any(
        this.db
          .select({ one: sql`1` })
          .from(offerLetterTemplates)
          .where(eq(offerLetterTemplates.orgId, orgId))
          .limit(1),
      ),
      this.any(
        this.db
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

  private async any(query: PromiseLike<unknown[]>): Promise<boolean> {
    return (await query).length > 0;
  }
}
