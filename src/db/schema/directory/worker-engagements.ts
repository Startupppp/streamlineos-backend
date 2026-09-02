import {
  pgTable,
  text,
  date,
  boolean,
  bigint,
  integer,
  timestamp,
  index,
  uniqueIndex,
  unique,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { workerEngagementStatusEnum } from "../common/enums";
import { organizations, organizationMembers } from "../common/auth";
import { orgUnits } from "../common/organization";
import { workers } from "./workers";
import { hrJobRoles, hrJobLevels } from "../hr/core-org";

export type WorkerEngagementType =
  | "FULL_TIME"
  | "PART_TIME"
  | "CONTRACTOR"
  | "CONSULTANT"
  | "INTERN"
  | "TEMPORARY"
  | "AGENCY"
  | "FREELANCER";

export const workerEngagements = pgTable(
  "worker_engagements",
  {
    workerEngagementId: text("worker_engagement_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    workerId: text("worker_id").notNull(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on"),
    workerType: text("worker_type").$type<WorkerEngagementType>().notNull(),
    status: workerEngagementStatusEnum("status").default("PLANNED").notNull(),
    isPrimary: boolean("is_primary").default(false).notNull(),
    departmentId: text("department_id"),
    businessUnitId: text("business_unit_id"),
    branchId: text("branch_id"),
    locationId: text("location_id"),
    teamId: text("team_id"),
    managerEngagementId: text("manager_engagement_id"),
    designation: text("designation"),
    jobRoleId: integer("job_role_id"),
    jobLevelId: integer("job_level_id"),
    employmentTypeId: integer("employment_type_id"),
    probationEndsOn: date("probation_ends_on"),
    noticePeriodDays: integer("notice_period_days"),
    terminationReason: text("termination_reason"),
    terminationNotes: text("termination_notes"),
    stateReason: text("state_reason"),
    lastStateEventId: bigint("last_state_event_id", { mode: "bigint" }),
    rowVersion: integer("row_version").default(1).notNull(),
    createdByMembershipId: integer("created_by_membership_id"),
    updatedByMembershipId: integer("updated_by_membership_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedByMembershipId: integer("archived_by_membership_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("uniq_worker_engagements_org_engagement").on(
      table.organizationId,
      table.workerEngagementId,
    ),
    unique("uniq_worker_engagements_org_worker_engagement").on(
      table.organizationId,
      table.workerId,
      table.workerEngagementId,
    ),
    uniqueIndex("uniq_worker_engagements_active_primary")
      .on(table.organizationId, table.workerId)
      .where(sql`is_primary = true AND status = 'ACTIVE'`),
    uniqueIndex("uniq_worker_engagements_active_primary_unarchived")
      .on(table.organizationId, table.workerId)
      .where(
        sql`${table.isPrimary} = true AND ${table.status} = 'ACTIVE' AND ${table.archivedAt} IS NULL`,
      ),
    index("idx_worker_engagements_org").on(table.organizationId),
    index("idx_worker_engagements_worker").on(table.workerId),
    index("idx_worker_engagements_org_status").on(
      table.organizationId,
      table.status,
    ),
    index("idx_worker_engagements_org_starts").on(
      table.organizationId,
      table.startsOn,
    ),
    index("idx_worker_engagements_manager").on(table.managerEngagementId),
    index("idx_worker_engagements_org_manager").on(
      table.organizationId,
      table.managerEngagementId,
    ),
    index("idx_worker_engagements_org_business_unit").on(
      table.organizationId,
      table.businessUnitId,
    ),
    index("idx_worker_engagements_org_branch").on(
      table.organizationId,
      table.branchId,
    ),
    index("idx_worker_engagements_org_department").on(
      table.organizationId,
      table.departmentId,
    ),
    index("idx_worker_engagements_org_team").on(
      table.organizationId,
      table.teamId,
    ),
    index("idx_worker_engagements_org_location").on(
      table.organizationId,
      table.locationId,
    ),
    index("idx_worker_engagements_created_actor").on(
      table.organizationId,
      table.createdByMembershipId,
    ),
    index("idx_worker_engagements_updated_actor").on(
      table.organizationId,
      table.updatedByMembershipId,
    ),
    index("idx_worker_engagements_archived_actor").on(
      table.organizationId,
      table.archivedByMembershipId,
    ),
    foreignKey({
      columns: [table.organizationId, table.workerId],
      foreignColumns: [workers.organizationId, workers.workerId],
      name: "fk_worker_engagements_org_worker",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.jobRoleId],
      foreignColumns: [hrJobRoles.orgId, hrJobRoles.id],
      name: "fk_worker_engagements_job_role_id_org",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.organizationId, table.jobLevelId],
      foreignColumns: [hrJobLevels.orgId, hrJobLevels.id],
      name: "fk_worker_engagements_job_level_id_org",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.organizationId, table.workerId],
      foreignColumns: [workers.organizationId, workers.workerId],
      name: "fk_worker_engagements_org_worker_restrict_p1",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.managerEngagementId],
      foreignColumns: [table.organizationId, table.workerEngagementId],
      name: "fk_worker_engagements_org_manager",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.businessUnitId],
      foreignColumns: [orgUnits.orgId, orgUnits.id],
      name: "fk_worker_engagements_org_business_unit",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.branchId],
      foreignColumns: [orgUnits.orgId, orgUnits.id],
      name: "fk_worker_engagements_org_branch",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.departmentId],
      foreignColumns: [orgUnits.orgId, orgUnits.id],
      name: "fk_worker_engagements_org_department",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.teamId],
      foreignColumns: [orgUnits.orgId, orgUnits.id],
      name: "fk_worker_engagements_org_team",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.locationId],
      foreignColumns: [orgUnits.orgId, orgUnits.id],
      name: "fk_worker_engagements_org_location",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.jobRoleId],
      foreignColumns: [hrJobRoles.orgId, hrJobRoles.id],
      name: "fk_worker_engagements_org_job_role",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.jobLevelId],
      foreignColumns: [hrJobLevels.orgId, hrJobLevels.id],
      name: "fk_worker_engagements_org_job_level",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.createdByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_worker_engagements_created_actor",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.organizationId, table.updatedByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_worker_engagements_updated_actor",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.archivedByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_worker_engagements_archived_actor",
    }).onDelete("restrict"),
    check(
      "chk_worker_engagements_dates",
      sql`${table.endsOn} IS NULL OR ${table.endsOn} > ${table.startsOn}`,
    ),
    check(
      "chk_worker_engagements_worker_type",
      sql`${table.workerType} IN ('FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'CONSULTANT', 'INTERN', 'TEMPORARY', 'AGENCY', 'FREELANCER')`,
    ),
    check(
      "chk_worker_engagements_state_reason",
      sql`${table.stateReason} IS NULL OR btrim(${table.stateReason}) <> ''`,
    ),
    check(
      "chk_worker_engagements_row_version",
      sql`${table.rowVersion} > 0`,
    ),
  ],
);
