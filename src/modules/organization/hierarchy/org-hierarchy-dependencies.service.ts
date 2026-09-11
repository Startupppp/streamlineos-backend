import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import {
  clientAccounts,
  employeeSalaryProfiles,
  headcountRequests,
  hrCompBudgetPools,
  hrCompCycles,
  hrEmergencyEvents,
  hrEmployments,
  hrHeadcountPlans,
  hrPeople,
  hrPositions,
  hrTimeDevices,
  incentiveConfig,
  invWarehouses,
  jobPostings,
  legalEntities,
  onboardingTemplates,
  orgUnitMembers,
  orgUnits,
  organizationMembers,
  principalGroups,
  workerEngagements,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";

export const ORG_UNIT_DEPENDENCY_ERROR = "ORG_UNIT_HAS_DEPENDENCIES";

export type OrgUnitKind = typeof orgUnits.$inferSelect.kind;

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
    includeLegalEntities: boolean,
  ): SQL[] {
    const queries: SQL[] = [
      countQuery(
        "child_units",
        "Non-archived child organization units",
        sql`${orgUnits}`,
        sql`${orgUnits.orgId} = ${orgId} AND ${orgUnits.parentId} = ${unitId} AND ${orgUnits.deletedAt} IS NULL ${sql`AND ${orgUnits.status} <> 'ARCHIVED'`}`,
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
    ];

    // Legal entities are being introduced behind a staged schema rollout. A
    // workspace on the earlier schema cannot contain legal-entity references,
    // so omit this dependency query until the relation exists instead of
    // turning every hierarchy archive into an undefined-table 500.
    if (includeLegalEntities)
      queries.push(
        countQuery(
          "legal_entities",
          "Active legal entities linked to this unit",
          sql`${legalEntities}`,
          sql`${legalEntities.orgId} = ${orgId} AND ${legalEntities.orgUnitId} = ${unitId} ${sql`AND ${legalEntities.status} = 'ACTIVE' AND ${legalEntities.deletedAt} IS NULL`}`,
        ),
      );

    const engagementStatus = sql`AND ${workerEngagements.status} IN ('PLANNED', 'ACTIVE')`;
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
          "Current worker assignments",
          sql`${workerEngagements}`,
          sql`${workerEngagements.organizationId} = ${orgId} AND ${engagementColumn} = ${unitId} ${engagementStatus}`,
        ),
      );
    }

    if (kind === "BRANCH") {
      const memberStatus = sql`AND ${organizationMembers.status} IN ('INVITED', 'ACTIVE', 'SUSPENDED')`;
      queries.push(
        countQuery(
          "member_profiles",
          "Current organization member profiles",
          sql`${users} INNER JOIN ${organizationMembers} ON ${organizationMembers.userId} = ${users.id} AND ${organizationMembers.orgId} = ${orgId} LEFT JOIN ${hrPeople} ON ${hrPeople.orgId} = ${orgId} AND ${hrPeople.userId} = ${users.id} AND ${hrPeople.deletedAt} IS NULL LEFT JOIN ${hrEmployments} ON ${hrEmployments.orgId} = ${orgId} AND ${hrEmployments.personId} = ${hrPeople.id} AND ${hrEmployments.isPrimary} = true AND ${hrEmployments.deletedAt} IS NULL`,
          sql`${hrEmployments.locationId} = ${unitId} ${memberStatus}`,
        ),
        countQuery(
          "client_accounts",
          "Client accounts assigned to this branch",
          sql`${clientAccounts}`,
          sql`${clientAccounts.orgId} = ${orgId} AND ${clientAccounts.branchId} = ${unitId}`,
        ),
        countQuery(
          "warehouses",
          "Active inventory warehouses assigned to this branch",
          sql`${invWarehouses}`,
          sql`${invWarehouses.orgId} = ${orgId} AND ${invWarehouses.branchId} = ${unitId} ${sql`AND ${invWarehouses.isActive} = true`}`,
        ),
        countQuery(
          "incentive_rules",
          "Sales incentive rules assigned to this branch",
          sql`${incentiveConfig}`,
          sql`${incentiveConfig.orgId} = ${orgId} AND ${incentiveConfig.branchId} = ${unitId} ${sql`AND ${incentiveConfig.isActive} = true`}`,
        ),
      );
    }

    if (kind === "DEPARTMENT") {
      const currentEmployment = sql`AND ${hrEmployments.lifecycleStatus} NOT IN ('EXITED', 'ALUMNI')`;
      const memberStatus = sql`AND ${organizationMembers.status} IN ('INVITED', 'ACTIVE', 'SUSPENDED')`;
      queries.push(
        countQuery(
          "member_profiles",
          "Current organization member profiles",
          sql`${users} INNER JOIN ${organizationMembers} ON ${organizationMembers.userId} = ${users.id} AND ${organizationMembers.orgId} = ${orgId} LEFT JOIN ${hrPeople} ON ${hrPeople.orgId} = ${orgId} AND ${hrPeople.userId} = ${users.id} AND ${hrPeople.deletedAt} IS NULL LEFT JOIN ${hrEmployments} ON ${hrEmployments.orgId} = ${orgId} AND ${hrEmployments.personId} = ${hrPeople.id} AND ${hrEmployments.isPrimary} = true AND ${hrEmployments.deletedAt} IS NULL`,
          sql`${hrEmployments.departmentId} = ${unitId} ${memberStatus}`,
        ),
        countQuery(
          "employee_assignments",
          "Current employee assignments",
          sql`${hrEmployments}`,
          sql`${hrEmployments.orgId} = ${orgId} AND ${hrEmployments.departmentId} = ${unitId} ${currentEmployment}`,
        ),
        countQuery(
          "positions",
          "Current positions assigned to this department",
          sql`${hrPositions}`,
          sql`${hrPositions.orgId} = ${orgId} AND ${hrPositions.departmentId} = ${unitId} ${sql`AND ${hrPositions.deletedAt} IS NULL`}`,
        ),
        countQuery(
          "job_postings",
          "Current job postings assigned to this department",
          sql`${jobPostings}`,
          sql`${jobPostings.orgId} = ${orgId} AND ${jobPostings.orgDepartmentId} = ${unitId} ${sql`AND ${jobPostings.status} NOT IN ('CLOSED', 'FILLED')`}`,
        ),
        countQuery(
          "headcount_requests",
          "Open headcount requests assigned to this department",
          sql`${headcountRequests}`,
          sql`${headcountRequests.orgId} = ${orgId} AND ${headcountRequests.orgDepartmentId} = ${unitId} ${sql`AND ${headcountRequests.status} NOT IN ('REJECTED', 'JOB_CREATED')`}`,
        ),
        countQuery(
          "headcount_plans",
          "Headcount plans assigned to this department",
          sql`${hrHeadcountPlans}`,
          sql`${hrHeadcountPlans.orgId} = ${orgId} AND ${hrHeadcountPlans.departmentId} = ${unitId}`,
        ),
        countQuery(
          "onboarding_templates",
          "Active onboarding templates assigned to this department",
          sql`${onboardingTemplates}`,
          sql`${onboardingTemplates.orgId} = ${orgId} AND ${onboardingTemplates.departmentId} = ${unitId} ${sql`AND ${onboardingTemplates.isActive} = true`}`,
        ),
        countQuery(
          "compensation_budgets",
          "Open compensation budgets assigned to this department",
          sql`${hrCompBudgetPools} INNER JOIN ${hrCompCycles} ON ${hrCompCycles.id} = ${hrCompBudgetPools.cycleId} AND ${hrCompCycles.orgId} = ${orgId}`,
          sql`${hrCompBudgetPools.orgId} = ${orgId} AND ${hrCompBudgetPools.departmentId} = ${unitId} ${sql`AND ${hrCompCycles.status} <> 'closed'`}`,
        ),
      );
    }

    if (kind === "LOCATION") {
      const currentEmployment = sql`AND ${hrEmployments.lifecycleStatus} NOT IN ('EXITED', 'ALUMNI')`;
      queries.push(
        countQuery(
          "employee_assignments",
          "Current employee assignments",
          sql`${hrEmployments}`,
          sql`${hrEmployments.orgId} = ${orgId} AND ${hrEmployments.locationId} = ${unitId} ${currentEmployment}`,
        ),
        countQuery(
          "time_devices",
          "Attendance devices assigned to this location",
          sql`${hrTimeDevices}`,
          sql`${hrTimeDevices.orgId} = ${orgId} AND ${hrTimeDevices.locationId} = ${unitId} ${sql`AND ${hrTimeDevices.status} = 'active'`}`,
        ),
        countQuery(
          "emergency_events",
          "Active emergency events",
          sql`${hrEmergencyEvents}`,
          sql`${hrEmergencyEvents.orgId} = ${orgId} AND ${hrEmergencyEvents.locationId} = ${unitId} ${sql`AND ${hrEmergencyEvents.status} = 'active'`}`,
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
          "Current employee salary profiles",
          sql`${employeeSalaryProfiles}`,
          sql`${employeeSalaryProfiles.orgId} = ${orgId} AND ${matchesUnitCodeOrName(
            employeeSalaryProfiles.costCenter,
          )} ${sql`AND ${employeeSalaryProfiles.status} IN ('UPCOMING', 'ACTIVE')`}`,
        ),
      );
    }

    return queries;
  }

  async listDependencies(
    orgId: string,
    unitId: string,
    kind: OrgUnitKind,
  ): Promise<OrgUnitDependency[]> {
    const [capability] = await this.db.execute<{ available: boolean }>(sql`
      SELECT to_regclass('public.legal_entities') IS NOT NULL AS available
    `);
    const rows = await this.db.execute<DependencyCountRow>(
      sql.join(
        this.buildQueries(orgId, unitId, kind, capability?.available === true),
        sql` UNION ALL `,
      ),
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
  ): Promise<void> {
    const dependencies = await this.listDependencies(orgId, unitId, kind);
    if (dependencies.length === 0) return;

    throw new ConflictException({
      code: ORG_UNIT_DEPENDENCY_ERROR,
      message: `This ${KIND_LABELS[kind]} is still in use. Move or update its dependent records before you archive it.`,
      details: {
        unitId,
        unitKind: kind,
        action: "archive",
        dependencies,
        totalDependencies: dependencies.reduce(
          (total, dependency) => total + dependency.count,
          0,
        ),
      },
    });
  }

  assertCanArchive(orgId: string, unitId: string, kind: OrgUnitKind) {
    return this.assertNoDependencies(orgId, unitId, kind);
  }
}
