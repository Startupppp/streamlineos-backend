import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
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
      departmentsCount,
      locationsCount,
      jobRolesCount,
      positionsCount,
      leavePoliciesCount,
      hasHolidays,
      shiftsCount,
      onboardingTemplatesCount,
      documentTypesCount,
      workflowsCount,
      salaryComponentsCount,
      payrollPoliciesCount,
      hiringFlowsCount,
      scorecardTemplatesCount,
      offerTemplatesCount,
      employeesCount,
    ] = await Promise.all([
      this.db.query.organizations.findFirst({
        where: eq(organizations.id, orgId),
        columns: { name: true, country: true, timezone: true },
      }),
      this.countRows(
        this.db
          .select({ value: count() })
          .from(orgUnits)
          .where(and(eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "DEPARTMENT"), isNull(orgUnits.deletedAt))),
      ),
      this.countRows(
        this.db
          .select({ value: count() })
          .from(orgUnits)
          .where(and(eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "LOCATION"), isNull(orgUnits.deletedAt))),
      ),
      this.countRows(
        this.db
          .select({ value: count() })
          .from(hrJobRoles)
          .where(and(eq(hrJobRoles.orgId, orgId), eq(hrJobRoles.isActive, true))),
      ),
      this.countRows(
        this.db
          .select({ value: count() })
          .from(hrPositions)
          .where(and(eq(hrPositions.orgId, orgId), isNull(hrPositions.deletedAt))),
      ),
      this.countRows(
        this.db
          .select({ value: count() })
          .from(leavePolicies)
          .where(and(eq(leavePolicies.orgId, orgId), eq(leavePolicies.isActive, true))),
      ),
      hasCompatibleHolidays(this.db, orgId),
      this.countRows(
        this.db
          .select({ value: count() })
          .from(shiftTemplates)
          .where(and(eq(shiftTemplates.orgId, orgId), eq(shiftTemplates.isActive, true))),
      ),
      this.countRows(
        this.db
          .select({ value: count() })
          .from(onboardingTemplates)
          .where(and(eq(onboardingTemplates.orgId, orgId), eq(onboardingTemplates.isActive, true))),
      ),
      this.countRows(
        this.db
          .select({ value: count() })
          .from(documentTypes)
          .where(and(eq(documentTypes.orgId, orgId), eq(documentTypes.isActive, true))),
      ),
      this.countRows(
        this.db
          .select({ value: count() })
          .from(hrWorkflowDefinitions)
          .where(
            and(
              eq(hrWorkflowDefinitions.orgId, orgId),
              eq(hrWorkflowDefinitions.status, "active"),
              isNull(hrWorkflowDefinitions.deletedAt),
            ),
          ),
      ),
      this.countRows(
        this.db
          .select({ value: count() })
          .from(salaryComponents)
          .where(and(eq(salaryComponents.orgId, orgId), eq(salaryComponents.isActive, true))),
      ),
      this.countRows(
        this.db
          .select({ value: count() })
          .from(payrollPolicies)
          .where(and(eq(payrollPolicies.orgId, orgId), eq(payrollPolicies.status, "ACTIVE"))),
      ),
      this.countRows(this.db.select({ value: count() }).from(hiringFlows).where(eq(hiringFlows.orgId, orgId))),
      this.countRows(
        this.db
          .select({ value: count() })
          .from(scorecardTemplates)
          .where(and(eq(scorecardTemplates.orgId, orgId), eq(scorecardTemplates.isActive, true))),
      ),
      this.countRows(
        this.db.select({ value: count() }).from(offerLetterTemplates).where(eq(offerLetterTemplates.orgId, orgId)),
      ),
      this.countRows(
        this.db
          .select({ value: count() })
          .from(organizationMembers)
          .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.isOwner, false))),
      ),
    ]);

    return {
      org_profile: Boolean(org?.name && org.country && org.timezone),
      locations_departments: departmentsCount > 0 && locationsCount > 0,
      roles_positions: jobRolesCount > 0 && positionsCount > 0,
      leave_policies: leavePoliciesCount > 0,
      holiday_calendar: hasHolidays,
      attendance_schedule: shiftsCount > 0,
      onboarding_template: onboardingTemplatesCount > 0,
      document_types: documentTypesCount > 0,
      approval_workflows: workflowsCount > 0,
      payroll_setup: salaryComponentsCount > 0 && payrollPoliciesCount > 0,
      recruitment_setup: hiringFlowsCount > 0 || scorecardTemplatesCount > 0 || offerTemplatesCount > 0,
      first_employees: employeesCount > 0,
    };
  }

  private async countRows(query: PromiseLike<{ value: number }[]>): Promise<number> {
    const rows = await query;
    return rows[0]?.value ?? 0;
  }
}
