import { pgTable, text, serial, timestamp, boolean, decimal, integer, index } from "drizzle-orm/pg-core";
import { organizations } from "../auth";
import { leaveTypes } from "./leaves";

export const leavePolicies = pgTable("leave_policies", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  leaveTypeId: integer("leave_type_id").references(() => leaveTypes.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  accrualType: text("accrual_type").default("ANNUAL").notNull(),
  accrualRate: decimal("accrual_rate", { precision: 6, scale: 2 }).notNull(),
  maxBalance: decimal("max_balance", { precision: 6, scale: 2 }),
  carryForwardDays: decimal("carry_forward_days", { precision: 6, scale: 2 }).default("0").notNull(),
  carryForwardExpiryMonths: integer("carry_forward_expiry_months"),
  encashable: boolean("encashable").default(false).notNull(),
  probationRestricted: boolean("probation_restricted").default(false).notNull(),
  genderRestriction: text("gender_restriction"),
  appliesTo: text("applies_to").default("ALL").notNull(),
  effectiveFrom: text("effective_from").notNull(),
  effectiveTo: text("effective_to"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_leave_policies_org_type").on(table.orgId, table.leaveTypeId),
]);
