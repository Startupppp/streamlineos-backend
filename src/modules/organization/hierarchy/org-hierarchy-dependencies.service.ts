import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import {
  clientAccounts,
  documents,
  employeeSalaryProfiles,
  finBudgetLines,
  headcountRequests,
  hrCompBudgetPools,
  hrCompCycles,
  hrEmergencyEvents,
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
  organizationMembers,
  principalGroups,
  payrollJournalBatchLines,
  workerEngagements,
  users,
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

function countQuery(key: string, label: string, table: SQL, where: SQL): SQL {
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
        strict
          ? "Child organization units"
          : "Non-archived child organization units",
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
        strict
          ? "Legal entity history linked to this unit"
          : "Active legal entities linked to this unit",
        sql`${legalEntities}`,
        sql`${legalEntities.orgId} = ${orgId} AND ${legalEntities.orgUnitId} = ${unitId} ${
          strict
            ? sql``
            : sql`AND ${legalEntities.status} = 'ACTIVE' AND ${legalEntities.deletedAt} IS NULL`
        }`,
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
      const memberStatus = strict
        ? sql``
        : sql`AND ${organizationMembers.status} IN ('INVITED', 'ACTIVE', 'SUSPENDED')`;
      queries.push(
        countQuery(
          "member_profiles",
          strict
            ? "Organization member profile history"
            : "Current organization member profiles",
          sql`${users} INNER JOIN ${organizationMembers} ON ${organizationMembers.userId} = ${users.id} AND ${organizationMembers.orgId} = ${orgId}`,
          sql`${users.branchId} = ${unitId} ${memberStatus}`,
        ),
        countQuery(
          "client_accounts",
          "Client accounts assigned to this branch",
          sql`${clientAccounts}`,
          sql`${clientAccounts.orgId} = ${orgId} AND ${clientAccounts.branchId} = ${unitId}`,
        ),
        countQuery(
          "warehouses",
          strict
            ? "Inventory warehouse history"
            : "Active inventory warehouses assigned to this branch",
          sql`${invWarehouses}`,
          sql`${invWarehouses.orgId} = ${orgId} AND ${invWarehouses.branchId} = ${unitId} ${
            strict ? sql`` : sql`AND ${invWarehouses.isActive} = true`
          }`,
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
      const memberStatus = strict
        ? sql``
        : sql`AND ${organizationMembers.status} IN ('INVITED', 'ACTIVE', 'SUSPENDED')`;
      queries.push(
        countQuery(
          "member_profiles",
          strict
            ? "Organization member profile history"
            : "Current organization member profiles",
          sql`${users} INNER JOIN ${organizationMembers} ON ${organizationMembers.userId} = ${users.id} AND ${organizationMembers.orgId} = ${orgId}`,
          sql`${users.orgDepartmentId} = ${unitId} ${memberStatus}`,
        ),
        countQuery(
          "employee_assignments",
          strict ? "Employee history" : "Current employee assignments",
          sql`${hrEmployments}`,
          sql`${hrEmployments.orgId} = ${orgId} AND ${hrEmployments.departmentId} = ${unitId} ${currentEmployment}`,
        ),
        countQuery(
          "positions",
          strict
            ? "Position history"
            : "Current positions assigned to this department",
          sql`${hrPositions}`,
          sql`${hrPositions.orgId} = ${orgId} AND ${hrPositions.departmentId} = ${unitId} ${
            strict ? sql`` : sql`AND ${hrPositions.deletedAt} IS NULL`
          }`,
        ),
        countQuery(
          "job_postings",
          strict
            ? "Job posting history"
            : "Current job postings assigned to this department",
          sql`${jobPostings}`,
          sql`${jobPostings.orgId} = ${orgId} AND ${jobPostings.orgDepartmentId} = ${unitId} ${
            strict
              ? sql``
              : sql`AND ${jobPostings.status} NOT IN ('CLOSED', 'FILLED')`
          }`,
        ),
        countQuery(
          "headcount_requests",
          strict
            ? "Headcount request history"
            : "Open headcount requests assigned to this department",
          sql`${headcountRequests}`,
          sql`${headcountRequests.orgId} = ${orgId} AND ${headcountRequests.orgDepartmentId} = ${unitId} ${
            strict
              ? sql``
              : sql`AND ${headcountRequests.status} NOT IN ('REJECTED', 'JOB_CREATED')`
          }`,
        ),
        countQuery(
          "headcount_plans",
          "Headcount plans assigned to this department",
          sql`${hrHeadcountPlans}`,
          sql`${hrHeadcountPlans.orgId} = ${orgId} AND ${hrHeadcountPlans.departmentId} = ${unitId}`,
        ),
        countQuery(
          "onboarding_templates",
          strict
            ? "Onboarding template history"
            : "Active onboarding templates assigned to this department",
          sql`${onboardingTemplates}`,
          sql`${onboardingTemplates.orgId} = ${orgId} AND ${onboardingTemplates.departmentId} = ${unitId} ${
            strict ? sql`` : sql`AND ${onboardingTemplates.isActive} = true`
          }`,
        ),
        countQuery(
          "compensation_budgets",
          strict
            ? "Compensation budget history"
            : "Open compensation budgets assigned to this department",
          strict
            ? sql`${hrCompBudgetPools}`
            : sql`${hrCompBudgetPools} INNER JOIN ${hrCompCycles} ON ${hrCompCycles.id} = ${hrCompBudgetPools.cycleId} AND ${hrCompCycles.orgId} = ${orgId}`,
          sql`${hrCompBudgetPools.orgId} = ${orgId} AND ${hrCompBudgetPools.departmentId} = ${unitId} ${
            strict ? sql`` : sql`AND ${hrCompCycles.status} <> 'closed'`
          }`,
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
        countQuery(
          "emergency_events",
          strict ? "Emergency event history" : "Active emergency events",
          sql`${hrEmergencyEvents}`,
          sql`${hrEmergencyEvents.orgId} = ${orgId} AND ${hrEmergencyEvents.locationId} = ${unitId} ${
            strict ? sql`` : sql`AND ${hrEmergencyEvents.status} = 'active'`
          }`,
        ),
      );
    }

    if (kind === "COST_CENTER") {
      const matchesUnitCodeOrName = (
        value: SQLWrapper,
      ) => sql`lower(trim(${value})) IN (
        SELECT lower(trim(${orgUnits.code}))
        FROM ${orgUnits}
        WHERE ${orgUnits.orgId} = ${orgId} AND ${orgUnits.id} = ${unitId}
        UNION ALL
        SELECT lower(trim(${orgUnits.name}))
        FROM ${orgUnits}
        WHERE ${orgUnits.orgId} = ${orgId} AND ${orgUnits.id} = ${unitId}
      )`;
      queries.push(
        countQuery(
          "salary_profiles",
          strict
            ? "Employee salary profile history"
            : "Current employee salary profiles",
          sql`${employeeSalaryProfiles}`,
          sql`${employeeSalaryProfiles.orgId} = ${orgId} AND ${matchesUnitCodeOrName(
            employeeSalaryProfiles.costCenter,
          )} ${
            strict
              ? sql``
              : sql`AND ${employeeSalaryProfiles.status} IN ('UPCOMING', 'ACTIVE')`
          }`,
        ),
      );
      if (strict)
        queries.push(
          countQuery(
            "payroll_journal_lines",
            "Payroll journal history",
            sql`${payrollJournalBatchLines}`,
            sql`${payrollJournalBatchLines.orgId} = ${orgId} AND ${matchesUnitCodeOrName(
              payrollJournalBatchLines.costCenter,
            )}`,
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
