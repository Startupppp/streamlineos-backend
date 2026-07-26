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
  jsonb,
} from "drizzle-orm/pg-core";
import { organizations, users } from "../auth";
import { projects } from "./core";

export const timesheetPeriods = pgTable("timesheet_periods", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  status: text("status").notNull().default("OPEN"),
  totalHours: decimal("total_hours", { precision: 8, scale: 2 }).notNull().default("0"),
  billableHours: decimal("billable_hours", { precision: 8, scale: 2 }).notNull().default("0"),
  nonBillableHours: decimal("non_billable_hours", { precision: 8, scale: 2 }).notNull().default("0"),
  submittedAt: timestamp("submitted_at"),
  approvedAt: timestamp("approved_at"),
  rejectedAt: timestamp("rejected_at"),
  lockedAt: timestamp("locked_at"),
  currentApproverId: text("current_approver_id").references(() => users.id, { onDelete: "set null" }),
  approvedBy: text("approved_by").references(() => users.id, { onDelete: "set null" }),
  rejectionReason: text("rejection_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => [
  uniqueIndex("uniq_timesheet_periods_user_range").on(t.orgId, t.userId, t.periodStart, t.periodEnd),
  index("idx_timesheet_periods_user_start").on(t.orgId, t.userId, t.periodStart),
  index("idx_timesheet_periods_org_status").on(t.orgId, t.status),
]);

export const timerSessions = pgTable("timer_sessions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "set null" }),
  ticketId: integer("ticket_id"),
  description: text("description"),
  billable: boolean("billable").notNull().default(false),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  lastResumedAt: timestamp("last_resumed_at"),
  accumulatedSeconds: integer("accumulated_seconds").notNull().default(0),
  status: text("status").notNull().default("RUNNING"),
  source: text("source").notNull().default("WEB"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => [
  index("idx_timer_sessions_user_status").on(t.orgId, t.userId, t.status),
]);

export const timesheetAuditEvents = pgTable("timesheet_audit_events", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  action: text("action").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  reason: text("reason"),
  prevHash: text("prev_hash"),
  rowHash: text("row_hash"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("idx_timesheet_audit_entity").on(t.orgId, t.entityType, t.entityId, t.createdAt),
]);

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
]);

export const timesheetRates = pgTable("timesheet_rates", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  rateCardId: integer("rate_card_id").references(() => timesheetRateCards.id, { onDelete: "set null" }),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "set null" }),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  clientId: integer("client_id"),
  taskId: integer("task_id"),
  billingType: text("billing_type").notNull().default("BILLABLE"),
  billRate: decimal("bill_rate", { precision: 10, scale: 2 }).notNull(),
  costRate: decimal("cost_rate", { precision: 10, scale: 2 }),
  currency: text("currency").notNull().default("USD"),
  priority: integer("priority").notNull().default(0),
  effectiveFrom: date("effective_from"),
  effectiveTo: date("effective_to"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => [
  index("idx_timesheet_rates_org_priority").on(t.orgId, t.priority),
  index("idx_timesheet_rates_org_project").on(t.orgId, t.projectId),
]);

export const timesheetExceptions = pgTable("timesheet_exceptions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  periodId: integer("period_id").references(() => timesheetPeriods.id, { onDelete: "cascade" }),
  entryId: integer("entry_id"),
  rule: text("rule").notNull(),
  severity: text("severity").notNull().default("WARNING"),
  status: text("status").notNull().default("OPEN"),
  message: text("message").notNull(),
  details: jsonb("details"),
  ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "set null" }),
  dueDate: date("due_date"),
  resolutionReason: text("resolution_reason"),
  resolvedBy: text("resolved_by").references(() => users.id, { onDelete: "set null" }),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => [
  index("idx_ts_exceptions_org_status").on(t.orgId, t.status, t.severity),
  index("idx_ts_exceptions_user").on(t.orgId, t.userId),
  index("idx_ts_exceptions_period").on(t.periodId),
]);

export const timesheetSettingsHistory = pgTable("timesheet_settings_history", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  settings: jsonb("settings").notNull(),
  changedBy: text("changed_by").references(() => users.id, { onDelete: "set null" }),
  changeReason: text("change_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("uniq_ts_settings_history_version").on(t.orgId, t.version),
]);

export const timesheetBudgets = pgTable("timesheet_budgets", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }),
  clientId: integer("client_id"),
  budgetType: text("budget_type").notNull().default("HOURS"),
  budgetHours: decimal("budget_hours", { precision: 10, scale: 2 }),
  budgetAmount: decimal("budget_amount", { precision: 12, scale: 2 }),
  currency: text("currency").notNull().default("USD"),
  alertThresholds: jsonb("alert_thresholds").$type<number[]>().notNull().default([50, 80, 100]),
  startsAt: date("starts_at"),
  endsAt: date("ends_at"),
  status: text("status").notNull().default("ACTIVE"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => [
  index("idx_timesheet_budgets_org_status").on(t.orgId, t.status),
  index("idx_timesheet_budgets_org_project").on(t.orgId, t.projectId),
]);
