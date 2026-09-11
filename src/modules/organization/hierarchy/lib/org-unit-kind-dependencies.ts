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
  hrPeople,
  hrPositions,
  hrTimeDevices,
  incentiveConfig,
  incentives,
  invWarehouses,
  jobPostings,
  journalLines,
  onboardingTemplates,
  orgUnits,
  organizationMembers,
  payrollJournalBatchLines,
  users,
} from "../../../../db/schema";

export type OrgUnitKind = typeof orgUnits.$inferSelect.kind;
export type DependencyMode = "archive" | "retire";

/** One `SELECT key, label, count(*)` arm of the UNION ALL the caller assembles. */
export function countQuery(key: string, label: string, table: SQL, where: SQL): SQL {
  return sql`SELECT ${key}::text AS key, ${label}::text AS label, count(*)::int AS count FROM ${table} WHERE ${where}`;
}

/**
 * What depends on an org unit BECAUSE OF THE KIND IT IS.
 *
 * OrgHierarchyDependenciesService keeps the other half: the dependencies every
 * unit has whatever its kind — child units, unit members, principal-group
 * scopes, worker engagements, legal entities — which is why that half reaches
 * only for org-structure tables. This half is where the rest of the product
 * points back at the hierarchy, so it is the half that names hr_*, payroll,
 * finance, inventory, CRM and KB tables, and the half that grows every time a
 * module starts referencing a branch, a department, a location or a cost
 * centre. Keeping the two apart is what stops a new module's dependency from
 * being written into the universal list by accident, where it would be counted
 * for a cost centre that cannot possibly have one.
 *
 * `strict` is `mode === "retire"`: retiring counts history, archiving counts
 * only what is still live, so nearly every arm below differs between the two
 * only in its status predicate and its label.
 *
 * Pushes onto the caller's array rather than returning its own, because the
 * arms have to stay in the order the UNION ALL was already built in.
 */
export function pushKindDependencyQueries(
  queries: SQL[],
  orgId: string,
  unitId: string,
  kind: OrgUnitKind,
  strict: boolean,
): void {
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
        sql`${users} INNER JOIN ${organizationMembers} ON ${organizationMembers.userId} = ${users.id} AND ${organizationMembers.orgId} = ${orgId} LEFT JOIN ${hrPeople} ON ${hrPeople.orgId} = ${orgId} AND ${hrPeople.userId} = ${users.id} AND ${hrPeople.deletedAt} IS NULL LEFT JOIN ${hrEmployments} ON ${hrEmployments.orgId} = ${orgId} AND ${hrEmployments.personId} = ${hrPeople.id} AND ${hrEmployments.isPrimary} = true AND ${hrEmployments.deletedAt} IS NULL`,
        sql`${hrEmployments.departmentId} = ${unitId} ${memberStatus}`,
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
}
