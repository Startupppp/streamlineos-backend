import {
  pgTable,
  text,
  serial,
  timestamp,
  date,
  integer,
  jsonb,
  index,
  uniqueIndex,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations, organizationMembers } from "../common/auth";
import { timesheetPeriods } from "./periods";

export const timesheetExceptions = pgTable("timesheet_exceptions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userMembershipId: integer("user_membership_id"),
  periodId: integer("period_id"),
  entryId: integer("entry_id"),
  rule: text("rule").notNull(),
  severity: text("severity").notNull().default("WARNING"),
  status: text("status").notNull().default("OPEN"),
  message: text("message").notNull(),
  details: jsonb("details"),
  ownerMembershipId: integer("owner_membership_id"),
  dueDate: date("due_date"),
  resolutionReason: text("resolution_reason"),
  resolvedByMembershipId: integer("resolved_by_membership_id"),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => [
  foreignKey({ columns: [t.orgId, t.periodId], foreignColumns: [timesheetPeriods.orgId, timesheetPeriods.id], name: "fk_timesheet_exceptions_org_period" }).onDelete("cascade"),
  index("idx_ts_exceptions_org_status").on(t.orgId, t.status, t.severity),
  index("idx_ts_exceptions_user_membership").on(t.orgId, t.userMembershipId),
  uniqueIndex("uniq_ts_exceptions_open_rule")
    .on(
      t.orgId,
      sql`COALESCE(${t.userMembershipId}, -1)`,
      t.rule,
      sql`COALESCE(${t.periodId}, -1)`,
      sql`COALESCE(${t.entryId}, -1)`,
    )
    .where(sql`${t.status} = 'OPEN'`),
  foreignKey({
    columns: [t.orgId, t.userMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_timesheet_exceptions_user_membership",
  }).onDelete("set null"),
  index("idx_ts_exceptions_period").on(t.periodId),
  index("idx_timesheet_exceptions_org_owner_membership").on(t.orgId, t.ownerMembershipId),
  foreignKey({
    columns: [t.orgId, t.resolvedByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_timesheet_exceptions_resolved_by_membership",
  }).onDelete("set null"),
  foreignKey({
    columns: [t.orgId, t.ownerMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_timesheet_exceptions_owner_membership",
  }).onDelete("set null"),
]);
