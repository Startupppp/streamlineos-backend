import { pgTable, text, serial, timestamp, date, decimal, boolean, index, unique, integer, foreignKey } from "drizzle-orm/pg-core";
import { organizationMembers, organizations } from "../common/auth";

export const overtimeRequests = pgTable("overtime_requests", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").notNull(),
  userMembershipId: integer("user_membership_id"),
  date: date("date").notNull(),
  hours: decimal("hours", { precision: 5, scale: 2 }).notNull(),
  reason: text("reason"),
  status: text("status").default("PENDING").notNull(),
  approverId: text("approver_id"),
  approverMembershipId: integer("approver_membership_id"),
  convertToCompOff: boolean("convert_to_comp_off").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_overtime_requests_org_id").on(table.orgId, table.id),
  index("idx_overtime_org_status").on(table.orgId, table.status),
  index("idx_overtime_user").on(table.userId),
  index("idx_overtime_org_created").on(table.orgId, table.createdAt),
  index("idx_overtime_org_user_membership").on(table.orgId, table.userMembershipId),
  index("idx_overtime_org_approver_membership").on(table.orgId, table.approverMembershipId),
  foreignKey({ columns: [table.orgId, table.userMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_overtime_requests_user_actor" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.approverMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_overtime_requests_approver_actor" }).onDelete("set null"),
]);

export const compOffBalances = pgTable("comp_off_balances", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").notNull(),
  userMembershipId: integer("user_membership_id"),
  earnedDays: decimal("earned_days", { precision: 6, scale: 2 }).default("0").notNull(),
  usedDays: decimal("used_days", { precision: 6, scale: 2 }).default("0").notNull(),
  expiryDate: date("expiry_date"),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_comp_off_balances_org_id").on(table.orgId, table.id),
  index("idx_comp_off_user").on(table.userId),
  index("idx_comp_off_org_user").on(table.orgId, table.userId),
  index("idx_comp_off_org_user_membership").on(table.orgId, table.userMembershipId),
  foreignKey({ columns: [table.orgId, table.userMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_comp_off_balances_user_actor" }).onDelete("set null"),
]);
