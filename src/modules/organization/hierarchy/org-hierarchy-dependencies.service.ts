import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import {
  clientAccounts,
  documents,
  finBudgetLines,
  headcountRequests,
  hrCompBudgetPools,
  hrEmployments,
  hrHeadcountPlans,
  hrPositions,
  hrTimeDevices,
  incentiveConfig,
  incentives,
  invWarehouses,
  jobPostings,
  journalLines,
  legalEntities,
  onboardingTemplates,
  orgUnitMembers,
  orgUnits,
  principalGroups,
  workerEngagements,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";

export const ORG_UNIT_DEPENDENCY_ERROR = "ORG_UNIT_HAS_DEPENDENCIES";

type OrgUnitKind = typeof orgUnits.$inferSelect.kind;
type DependencyMode = "archive" | "retire";

export type OrgUnitDependency = {
  key: string;
  label: string;
  count: number;
};

type DependencyCountRow = {
  key: string;
  label: string;
  count: number | string;
};

const KIND_LABELS: Record<OrgUnitKind, string> = {
  BUSINESS_UNIT: "business unit",
  BRANCH: "branch",
  DEPARTMENT: "department",
  TEAM: "team",
  LOCATION: "location",
  COST_CENTER: "cost center",
};

function countQuery(
  key: string,
  label: string,
  table: SQL,
  where: SQL,
): SQL {
  return sql`SELECT ${key}::text AS key, ${label}::text AS label, count(*)::int AS count FROM ${table} WHERE ${where}`;
}

@Injectable()
export class OrgHierarchyDependenciesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private buildQueries(
    orgId: string,
    unitId: string,
    kind: OrgUnitKind,
    mode: DependencyMode,
  ): SQL[] {
    const strict = mode === "retire";
    const queries: SQL[] = [
      countQuery(
        "child_units",
        strict ? "Child organization units" : "Active child organization units",
        sql`${orgUnits}`,
        sql`${orgUnits.orgId} = ${orgId} AND ${orgUnits.parentId} = ${unitId} AND ${orgUnits.deletedAt} IS NULL ${
          strict ? sql`` : sql`AND ${orgUnits.status} <> 'ARCHIVED'`
        }`,
      ),
      countQuery(
        "unit_members",
        "People assigned directly to this unit",
        sql`${orgUnitMembers}`,
        sql`${orgUnitMembers.orgId} = ${orgId} AND ${orgUnitMembers.orgUnitId} = ${unitId}`,
      ),
      countQuery(
        "access_groups",
        "Access groups scoped to this unit",
        sql`${principalGroups}`,
        sql`${principalGroups.orgId} = ${orgId} AND ${principalGroups.orgUnitId} = ${unitId}`,
      ),
      countQuery(
        "legal_entities",
        "Legal entities linked to this unit",
        sql`${legalEntities}`,
        sql`${legalEntities.orgId} = ${orgId} AND ${legalEntities.orgUnitId} = ${unitId}`,
      ),
    ];

    const engagementStatus = strict
      ? sql``
      : sql`AND ${workerEngagements.status} IN ('PLANNED', 'ACTIVE')`;
    const engagementColumn =
      kind === "BUSINESS_UNIT"
        ? workerEngagements.businessUnitId
        : kind === "BRANCH"
          ? workerEngagements.branchId
          : kind === "DEPARTMENT"
            ? workerEngagements.departmentId
            : kind === "TEAM"
              ? workerEngagements.teamId
              : kind === "LOCATION"
                ? workerEngagements.locationId
                : null;
    if (engagementColumn) {
      queries.push(
        countQuery(
          "worker_assignments",
          strict ? "Worker engagement history" : "Current worker assignments",
          sql`${workerEngagements}`,
          sql`${workerEngagements.organizationId} = ${orgId} AND ${engagementColumn} = ${unitId} ${engagementStatus}`,
        ),
      );
    }

    if (kind === "BRANCH") {
      queries.push(
        countQuery(
          "client_accounts",
          "Client accounts assigned to this branch",
          sql`${clientAccounts}`,
          sql`${clientAccounts.orgId} = ${orgId} AND ${clientAccounts.branchId} = ${unitId}`,
        ),
        countQuery(
          "warehouses",
          "Inventory warehouses assigned to this branch",
          sql`${invWarehouses}`,
          sql`${invWarehouses.orgId} = ${orgId} AND ${invWarehouses.branchId} = ${unitId}`,
        ),
        countQuery(
          "incentive_rules",
          "Sales incentive rules assigned to this branch",
          sql`${incentiveConfig}`,
          sql`${incentiveConfig.orgId} = ${orgId} AND ${incentiveConfig.branchId} = ${unitId} ${
            strict ? sql`` : sql`AND ${incentiveConfig.isActive} = true`
          }`,
        ),
      );
      if (strict) {
        queries.push(
          countQuery(
            "incentive_history",
            "Sales incentive history",
            sql`${incentives}`,
            sql`${incentives.orgId} = ${orgId} AND ${incentives.branchId} = ${unitId}`,
          ),
        );
      }
    }

    if (kind === "DEPARTMENT") {
      const currentEmployment = strict
        ? sql``
        : sql`AND ${hrEmployments.lifecycleStatus} NOT IN ('EXITED', 'ALUMNI')`;
      queries.push(
        countQuery(
          "employee_assignments",
          strict ? "Employee history" : "Current employee assignments",
          sql`${hrEmployments}`,
          sql`${hrEmployments.orgId} = ${orgId} AND ${hrEmployments.departmentId} = ${unitId} ${currentEmployment}`,
        ),
        countQuery(
          "positions",
          "Positions assigned to this department",
          sql`${hrPositions}`,
          sql`${hrPositions.orgId} = ${orgId} AND ${hrPositions.departmentId} = ${unitId}`,
        ),
        countQuery(
          "job_postings",
          "Job postings assigned to this department",
          sql`${jobPostings}`,
          sql`${jobPostings.orgId} = ${orgId} AND ${jobPostings.orgDepartmentId} = ${unitId}`,
        ),
        countQuery(
          "headcount_requests",
          "Headcount requests assigned to this department",
          sql`${headcountRequests}`,
          sql`${headcountRequests.orgId} = ${orgId} AND ${headcountRequests.orgDepartmentId} = ${unitId}`,
        ),
        countQuery(
          "headcount_plans",
          "Headcount plans assigned to this department",
          sql`${hrHeadcountPlans}`,
          sql`${hrHeadcountPlans.orgId} = ${orgId} AND ${hrHeadcountPlans.departmentId} = ${unitId}`,
        ),
        countQuery(
          "onboarding_templates",
          "Onboarding templates assigned to this department",
          sql`${onboardingTemplates}`,
          sql`${onboardingTemplates.orgId} = ${orgId} AND ${onboardingTemplates.departmentId} = ${unitId}`,
        ),
        countQuery(
          "compensation_budgets",
          "Compensation budgets assigned to this department",
          sql`${hrCompBudgetPools}`,
          sql`${hrCompBudgetPools.orgId} = ${orgId} AND ${hrCompBudgetPools.departmentId} = ${unitId}`,
        ),
      );
      if (strict) {
        queries.push(
          countQuery(
            "documents",
            "Documents filed under this department",
            sql`${documents}`,
            sql`${documents.orgId} = ${orgId} AND ${documents.departmentId} = ${unitId}`,
          ),
          countQuery(
            "budget_lines",
            "Finance budget lines",
            sql`${finBudgetLines}`,
            sql`${finBudgetLines.orgId} = ${orgId} AND ${finBudgetLines.departmentId} = ${unitId}`,
          ),
          countQuery(
            "journal_lines",
            "Accounting journal lines",
            sql`${journalLines}`,
            sql`${journalLines.orgId} = ${orgId} AND ${journalLines.departmentId} = ${unitId}`,
          ),
        );
      }
    }

    if (kind === "LOCATION") {
      const currentEmployment = strict
        ? sql``
        : sql`AND ${hrEmployments.lifecycleStatus} NOT IN ('EXITED', 'ALUMNI')`;
      queries.push(
        countQuery(
          "employee_assignments",
          strict ? "Employee history" : "Current employee assignments",
          sql`${hrEmployments}`,
          sql`${hrEmployments.orgId} = ${orgId} AND ${hrEmployments.locationId} = ${unitId} ${currentEmployment}`,
        ),
        countQuery(
          "time_devices",
          "Attendance devices assigned to this location",
          sql`${hrTimeDevices}`,
          sql`${hrTimeDevices.orgId} = ${orgId} AND ${hrTimeDevices.locationId} = ${unitId} ${
            strict ? sql`` : sql`AND ${hrTimeDevices.status} = 'active'`
          }`,
        ),
      );
    }

    return queries;
  }

  async listDependencies(
    orgId: string,
    unitId: string,
    kind: OrgUnitKind,
    mode: DependencyMode,
  ): Promise<OrgUnitDependency[]> {
    const rows = await this.db.execute<DependencyCountRow>(
      sql.join(this.buildQueries(orgId, unitId, kind, mode), sql` UNION ALL `),
    );
    return rows
      .map((row) => ({
        key: row.key,
        label: row.label,
        count: Number(row.count),
      }))
      .filter((row) => row.count > 0);
  }

  private async assertNoDependencies(
    orgId: string,
    unitId: string,
    kind: OrgUnitKind,
    mode: DependencyMode,
  ): Promise<void> {
    const dependencies = await this.listDependencies(orgId, unitId, kind, mode);
    if (dependencies.length === 0) return;

    const action = mode === "archive" ? "archive" : "remove";
    throw new ConflictException({
      code: ORG_UNIT_DEPENDENCY_ERROR,
      message: `This ${KIND_LABELS[kind]} is still in use. Move or update its dependent records before you ${action} it.`,
      details: {
        unitId,
        unitKind: kind,
        action,
        dependencies,
        totalDependencies: dependencies.reduce(
          (total, dependency) => total + dependency.count,
          0,
        ),
      },
    });
  }

  assertCanArchive(orgId: string, unitId: string, kind: OrgUnitKind) {
    return this.assertNoDependencies(orgId, unitId, kind, "archive");
  }

  assertCanRetire(orgId: string, unitId: string, kind: OrgUnitKind) {
    return this.assertNoDependencies(orgId, unitId, kind, "retire");
  }
}
