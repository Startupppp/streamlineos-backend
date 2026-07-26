import {
  pgTable,
  text,
  date,
  boolean,
  integer,
  timestamp,
  index,
  uniqueIndex,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { workerEngagementStatusEnum } from "../enums";
import { organizations, users } from "../auth";
import { workers } from "./workers";

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
    workerType: text("worker_type")
      .$type<
        | "FULL_TIME"
        | "PART_TIME"
        | "CONTRACTOR"
        | "CONSULTANT"
        | "INTERN"
        | "TEMPORARY"
        | "AGENCY"
        | "FREELANCER"
      >()
      .notNull(),
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
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_worker_engagements_org_engagement").on(
      table.organizationId,
      table.workerEngagementId,
    ),
    uniqueIndex("uniq_worker_engagements_active_primary")
      .on(table.organizationId, table.workerId)
      .where(sql`is_primary = true AND status = 'ACTIVE'`),
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
    foreignKey({
      columns: [table.organizationId, table.workerId],
      foreignColumns: [workers.organizationId, workers.workerId],
      name: "fk_worker_engagements_org_worker",
    }).onDelete("cascade"),
  ],
);
