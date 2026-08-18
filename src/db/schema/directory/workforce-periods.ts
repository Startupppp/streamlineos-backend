import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { organizationMembers, organizations } from "../common/auth";
import { orgUnits } from "../common/organization";
import { hrJobLevels, hrJobRoles } from "../hr/core-org";
import { shiftTemplates } from "../hr/shifts";
import {
  type WorkerEngagementType,
  workerEngagements,
} from "./worker-engagements";

type WorkerReportingLineType = "PRIMARY" | "DOTTED" | "MATRIX" | "FUNCTIONAL";

export const workerAssignmentPeriods = pgTable(
  "worker_assignment_periods",
  {
    assignmentPeriodId: text("assignment_period_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "restrict" })
      .notNull(),
    workerEngagementId: text("worker_engagement_id").notNull(),
    validFrom: date("valid_from").notNull(),
    validTo: date("valid_to").default(sql`'infinity'::date`).notNull(),
    isPrimary: boolean("is_primary").default(true).notNull(),
    businessUnitId: text("business_unit_id"),
    branchId: text("branch_id"),
    departmentId: text("department_id"),
    teamId: text("team_id"),
    locationId: text("location_id"),
    costCenterId: text("cost_center_id"),
    jobRoleId: integer("job_role_id"),
    jobLevelId: integer("job_level_id"),
    employmentType: text("employment_type").$type<WorkerEngagementType>(),
    designation: text("designation"),
    scheduleId: integer("schedule_id"),
    rowVersion: integer("row_version").default(1).notNull(),
    createdByMembershipId: integer("created_by_membership_id"),
    updatedByMembershipId: integer("updated_by_membership_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("uniq_worker_assignment_periods_org_id").on(
      table.organizationId,
      table.assignmentPeriodId,
    ),
    index("idx_worker_assignment_periods_engagement").on(
      table.organizationId,
      table.workerEngagementId,
      table.validFrom,
    ),
    index("idx_worker_assignment_periods_business_unit").on(
      table.organizationId,
      table.businessUnitId,
    ),
    index("idx_worker_assignment_periods_branch").on(
      table.organizationId,
      table.branchId,
    ),
    index("idx_worker_assignment_periods_department").on(
      table.organizationId,
      table.departmentId,
    ),
    index("idx_worker_assignment_periods_team").on(
      table.organizationId,
      table.teamId,
    ),
    index("idx_worker_assignment_periods_location").on(
      table.organizationId,
      table.locationId,
    ),
    index("idx_worker_assignment_periods_cost_center").on(
      table.organizationId,
      table.costCenterId,
    ),
    index("idx_worker_assignment_periods_job_role").on(
      table.organizationId,
      table.jobRoleId,
    ),
    index("idx_worker_assignment_periods_job_level").on(
      table.organizationId,
      table.jobLevelId,
    ),
    index("idx_worker_assignment_periods_schedule").on(
      table.organizationId,
      table.scheduleId,
    ),
    index("idx_worker_assignment_periods_created_actor").on(
      table.organizationId,
      table.createdByMembershipId,
    ),
    index("idx_worker_assignment_periods_updated_actor").on(
      table.organizationId,
      table.updatedByMembershipId,
    ),
    foreignKey({
      columns: [table.organizationId, table.workerEngagementId],
      foreignColumns: [
        workerEngagements.organizationId,
        workerEngagements.workerEngagementId,
      ],
      name: "fk_worker_assignment_periods_engagement",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.businessUnitId],
      foreignColumns: [orgUnits.orgId, orgUnits.id],
      name: "fk_worker_assignment_periods_business_unit",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.branchId],
      foreignColumns: [orgUnits.orgId, orgUnits.id],
      name: "fk_worker_assignment_periods_branch",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.departmentId],
      foreignColumns: [orgUnits.orgId, orgUnits.id],
      name: "fk_worker_assignment_periods_department",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.teamId],
      foreignColumns: [orgUnits.orgId, orgUnits.id],
      name: "fk_worker_assignment_periods_team",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.locationId],
      foreignColumns: [orgUnits.orgId, orgUnits.id],
      name: "fk_worker_assignment_periods_location",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.costCenterId],
      foreignColumns: [orgUnits.orgId, orgUnits.id],
      name: "fk_worker_assignment_periods_cost_center",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.jobRoleId],
      foreignColumns: [hrJobRoles.orgId, hrJobRoles.id],
      name: "fk_worker_assignment_periods_job_role",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.jobLevelId],
      foreignColumns: [hrJobLevels.orgId, hrJobLevels.id],
      name: "fk_worker_assignment_periods_job_level",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.scheduleId],
      foreignColumns: [shiftTemplates.orgId, shiftTemplates.id],
      name: "fk_worker_assignment_periods_schedule",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.createdByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_worker_assignment_periods_created_actor",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.updatedByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_worker_assignment_periods_updated_actor",
    }).onDelete("restrict"),
    check(
      "chk_worker_assignment_periods_dates",
      sql`${table.validFrom} < ${table.validTo}`,
    ),
    check(
      "chk_worker_assignment_periods_employment_type",
      sql`${table.employmentType} IS NULL OR ${table.employmentType} IN ('FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'CONSULTANT', 'INTERN', 'TEMPORARY', 'AGENCY', 'FREELANCER')`,
    ),
    check(
      "chk_worker_assignment_periods_row_version",
      sql`${table.rowVersion} > 0`,
    ),
  ],
);

export const workerReportingLines = pgTable(
  "worker_reporting_lines",
  {
    reportingLineId: text("reporting_line_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "restrict" })
      .notNull(),
    workerEngagementId: text("worker_engagement_id").notNull(),
    managerWorkerEngagementId: text("manager_worker_engagement_id").notNull(),
    lineType: text("line_type").$type<WorkerReportingLineType>().notNull(),
    validFrom: date("valid_from").notNull(),
    validTo: date("valid_to").default(sql`'infinity'::date`).notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
    createdByMembershipId: integer("created_by_membership_id"),
    updatedByMembershipId: integer("updated_by_membership_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("uniq_worker_reporting_lines_org_id").on(
      table.organizationId,
      table.reportingLineId,
    ),
    index("idx_worker_reporting_lines_subject").on(
      table.organizationId,
      table.workerEngagementId,
      table.lineType,
      table.validFrom,
    ),
    index("idx_worker_reporting_lines_manager").on(
      table.organizationId,
      table.managerWorkerEngagementId,
      table.validFrom,
    ),
    index("idx_worker_reporting_lines_created_actor").on(
      table.organizationId,
      table.createdByMembershipId,
    ),
    index("idx_worker_reporting_lines_updated_actor").on(
      table.organizationId,
      table.updatedByMembershipId,
    ),
    foreignKey({
      columns: [table.organizationId, table.workerEngagementId],
      foreignColumns: [
        workerEngagements.organizationId,
        workerEngagements.workerEngagementId,
      ],
      name: "fk_worker_reporting_lines_subject",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.managerWorkerEngagementId],
      foreignColumns: [
        workerEngagements.organizationId,
        workerEngagements.workerEngagementId,
      ],
      name: "fk_worker_reporting_lines_manager",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.createdByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_worker_reporting_lines_created_actor",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.updatedByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_worker_reporting_lines_updated_actor",
    }).onDelete("restrict"),
    check(
      "chk_worker_reporting_lines_no_self_manager",
      sql`${table.workerEngagementId} <> ${table.managerWorkerEngagementId}`,
    ),
    check(
      "chk_worker_reporting_lines_dates",
      sql`${table.validFrom} < ${table.validTo}`,
    ),
    check(
      "chk_worker_reporting_lines_type",
      sql`${table.lineType} IN ('PRIMARY', 'DOTTED', 'MATRIX', 'FUNCTIONAL')`,
    ),
    check(
      "chk_worker_reporting_lines_row_version",
      sql`${table.rowVersion} > 0`,
    ),
  ],
);
