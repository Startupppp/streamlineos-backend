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
  foreignKey,
} from "drizzle-orm/pg-core";
import { organizations, organizationMembers } from "../common/auth";
import { projects } from "../build/core";
import { timesheetBillingTypeEnum } from "./enums";
import { clients } from "../crm/contacts";

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
  rateCardId: integer("rate_card_id"),
  projectId: integer("project_id"),
  userMembershipId: integer("user_membership_id"),
  clientId: integer("client_id").references(() => clients.id, { onDelete: "set null" }),
  taskId: integer("task_id"),
  billingType: timesheetBillingTypeEnum("billing_type").notNull().default("BILLABLE"),
  billRate: decimal("bill_rate", { precision: 10, scale: 2 }).notNull(),
  costRate: decimal("cost_rate", { precision: 10, scale: 2 }),
  currency: text("currency").notNull().default("USD"),
  priority: integer("priority").notNull().default(0),
  effectiveFrom: date("effective_from"),
  effectiveTo: date("effective_to"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => [
  foreignKey({ columns: [t.orgId, t.rateCardId], foreignColumns: [timesheetRateCards.orgId, timesheetRateCards.id], name: "fk_timesheet_rates_rate_card_id_org" }),
  foreignKey({ columns: [t.orgId, t.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_timesheet_rates_project_id_org" }),
  index("idx_timesheet_rates_org_priority").on(t.orgId, t.priority),
  index("idx_timesheet_rates_org_project").on(t.orgId, t.projectId),
  index("idx_timesheet_rates_rate_card").on(t.rateCardId),
  index("idx_timesheet_rates_org_user_membership").on(t.orgId, t.userMembershipId),
  foreignKey({
    columns: [t.orgId, t.userMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_timesheet_rates_user_membership",
  }).onDelete("set null"),
]);
