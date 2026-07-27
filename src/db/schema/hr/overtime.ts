import { pgTable, text, serial, timestamp, date, decimal, boolean, index, unique } from "drizzle-orm/pg-core";
import { organizations, users } from "../common/auth";

export const overtimeRequests = pgTable("overtime_requests", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  date: date("date").notNull(),
  hours: decimal("hours", { precision: 5, scale: 2 }).notNull(),
  reason: text("reason"),
  status: text("status").default("PENDING").notNull(),
  approverId: text("approver_id").references(() => users.id),
  convertToCompOff: boolean("convert_to_comp_off").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_overtime_requests_org_id").on(table.orgId, table.id),
  index("idx_overtime_org_status").on(table.orgId, table.status),
  index("idx_overtime_user").on(table.userId),
  index("idx_overtime_org_created").on(table.orgId, table.createdAt),
]);

export const compOffBalances = pgTable("comp_off_balances", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  earnedDays: decimal("earned_days", { precision: 6, scale: 2 }).default("0").notNull(),
  usedDays: decimal("used_days", { precision: 6, scale: 2 }).default("0").notNull(),
  expiryDate: date("expiry_date"),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_comp_off_balances_org_id").on(table.orgId, table.id),
  index("idx_comp_off_user").on(table.userId),
  index("idx_comp_off_org_user").on(table.orgId, table.userId),
]);
