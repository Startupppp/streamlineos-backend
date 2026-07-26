import {
  pgTable,
  text,
  serial,
  timestamp,
  decimal,
  date,
  integer,
  index,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "../auth";
import { projects } from "../projects/core";
import { timesheetBudgetTypeEnum, timesheetBudgetStatusEnum } from "./enums";

export const timesheetBudgets = pgTable("timesheet_budgets", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }),
  clientId: integer("client_id"),
  budgetType: timesheetBudgetTypeEnum("budget_type").notNull().default("HOURS"),
  budgetHours: decimal("budget_hours", { precision: 10, scale: 2 }),
  budgetAmount: decimal("budget_amount", { precision: 12, scale: 2 }),
  currency: text("currency").notNull().default("USD"),
  alertThresholds: jsonb("alert_thresholds").$type<number[]>().notNull().default([50, 80, 100]),
  startsAt: date("starts_at"),
  endsAt: date("ends_at"),
  status: timesheetBudgetStatusEnum("status").notNull().default("ACTIVE"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => [
  index("idx_timesheet_budgets_org_status").on(t.orgId, t.status),
  index("idx_timesheet_budgets_org_project").on(t.orgId, t.projectId),
  uniqueIndex("uniq_timesheet_budgets_active_project")
    .on(t.orgId, t.projectId)
    .where(sql`status = 'ACTIVE'`),
]);
