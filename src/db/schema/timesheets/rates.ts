import {
  pgTable,
  text,
  serial,
  timestamp,
  boolean,
  decimal,
  date,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations, users } from "../auth";
import { projects } from "../projects/core";
import { timesheetBillingTypeEnum } from "./enums";

export const timesheetRateCards = pgTable("timesheet_rate_cards", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  currency: text("currency").notNull().default("USD"),
  isDefault: boolean("is_default").notNull().default(false),
  effectiveFrom: date("effective_from"),
  effectiveTo: date("effective_to"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => [
  index("idx_timesheet_rate_cards_org").on(t.orgId),
  uniqueIndex("uniq_timesheet_rate_cards_org_name").on(t.orgId, t.name),
]);

export const timesheetRates = pgTable("timesheet_rates", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  rateCardId: integer("rate_card_id").references(() => timesheetRateCards.id, { onDelete: "set null" }),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "set null" }),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  clientId: integer("client_id"),
  taskId: integer("task_id"),
  billingType: timesheetBillingTypeEnum("billing_type").notNull().default("BILLABLE"),
  billRate: decimal("bill_rate", { precision: 10, scale: 2 }).notNull(),
  costRate: decimal("cost_rate", { precision: 10, scale: 2 }),
  currency: text("currency").notNull().default("USD"),
  priority: integer("priority").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => [
  index("idx_timesheet_rates_org_priority").on(t.orgId, t.priority),
  index("idx_timesheet_rates_org_project").on(t.orgId, t.projectId),
  index("idx_timesheet_rates_rate_card").on(t.rateCardId),
]);
