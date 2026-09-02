import { date, foreignKey, index, integer, jsonb, pgTable, serial, text, timestamp, type AnyPgColumn, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { payrollPolicyStatusEnum, payFrequencyEnum, payrollCalendarEventTypeEnum } from "../common/enums";
import { organizations, users } from "../common/auth";

/**
 * `payroll_policies` and `payroll_policy_versions` reference each other, so naming the
 * parent columns inline makes each table's type depend on the other's and TypeScript
 * gives up with TS7022. The explicit `AnyPgColumn` return type is the documented Drizzle
 * escape hatch for that cycle -- the same one `.references((): AnyPgColumn => ...)` uses
 * elsewhere in this schema -- lifted to the tuple a composite foreign key needs.
 */
const activeVersionParentColumns = (): [AnyPgColumn, AnyPgColumn] => [
  payrollPolicyVersions.orgId,
  payrollPolicyVersions.id,
];

export const payrollPolicies = pgTable("payroll_policies", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  status: payrollPolicyStatusEnum("status").default("DRAFT").notNull(),
  country: text("country").notNull(),
  state: text("state"),
  legalEntityName: text("legal_entity_name"),
  currency: text("currency").default("INR").notNull(),
  payFrequency: payFrequencyEnum("pay_frequency").default("MONTHLY").notNull(),
  payDay: integer("pay_day").default(28).notNull(),
  employeeCount: integer("employee_count"),
  startMonth: text("start_month").notNull(),
  activeVersionId: integer("active_version_id"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({
    columns: [table.orgId, table.activeVersionId],
    foreignColumns: activeVersionParentColumns(),
    name: "fk_payroll_policies_active_version",
  }).onDelete("set null"),
  unique("uniq_payroll_policies_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_payroll_policies_org").on(table.orgId),
  index("idx_payroll_policies_active_version").on(table.orgId, table.activeVersionId),
  index("idx_payroll_policies_org_status").on(table.orgId, table.status),
]);

export const payrollPolicyVersions = pgTable("payroll_policy_versions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  policyId: integer("policy_id").notNull(),
  version: integer("version").notNull(),
  templateKey: text("template_key"),
  toggles: jsonb("toggles").$type<object>().notNull(),
  config: jsonb("config").$type<object>().notNull(),
  status: payrollPolicyStatusEnum("status").default("DRAFT").notNull(),
  effectiveFrom: date("effective_from").notNull(),
  reason: text("reason"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.policyId], foreignColumns: [payrollPolicies.orgId, payrollPolicies.id], name: "fk_payroll_policy_versions_policy_id_org" }).onDelete("cascade"),
  unique("uniq_payroll_policy_versions_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_payroll_policy_versions_policy_version").on(table.policyId, table.version),
  index("idx_payroll_policy_versions_org_policy").on(table.orgId, table.policyId),
]);

export const payrollTemplateActivations = pgTable("payroll_template_activations", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  policyVersionId: integer("policy_version_id").notNull(),
  templateKey: text("template_key").notNull(),
  snapshot: jsonb("snapshot").$type<object>().notNull(),
  activatedBy: text("activated_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.policyVersionId], foreignColumns: [payrollPolicyVersions.orgId, payrollPolicyVersions.id], name: "fk_payroll_template_activations_policy_version_id_org" }).onDelete("cascade"),
  unique("uniq_payroll_template_activations_org_id").on(table.orgId, table.id),
  index("idx_payroll_template_activations_org").on(table.orgId, table.policyVersionId),
]);

export const payrollCalendarEvents = pgTable("payroll_calendar_events", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  policyId: integer("policy_id"),
  month: text("month"),
  type: payrollCalendarEventTypeEnum("type").notNull(),
  date: date("date").notNull(),
  title: text("title").notNull(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.policyId], foreignColumns: [payrollPolicies.orgId, payrollPolicies.id], name: "fk_payroll_calendar_events_policy_id_org" }).onDelete("set null"),
  unique("uniq_payroll_calendar_events_org_id").on(table.orgId, table.id),
  index("idx_payroll_calendar_events_org_date").on(table.orgId, table.date),
]);

export const payrollAccountingMappings = pgTable("payroll_accounting_mappings", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  componentId: integer("component_id"),
  category: text("category"),
  ledgerName: text("ledger_name").notNull(),
  costCenterSource: text("cost_center_source"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_payroll_accounting_mappings_org_id").on(table.orgId, table.id),
  uniqueIndex("uq_payroll_accounting_mappings_org_component").on(table.orgId, table.componentId).where(sql`${table.componentId} IS NOT NULL`),
  uniqueIndex("uq_payroll_accounting_mappings_org_category").on(table.orgId, table.category).where(sql`${table.componentId} IS NULL`),
]);

export const payrollPoliciesRelations = relations(payrollPolicies, ({ one, many }) => ({
  versions: many(payrollPolicyVersions),
  calendarEvents: many(payrollCalendarEvents),
  createdByUser: one(users, { fields: [payrollPolicies.createdBy], references: [users.id], relationName: "policyCreatedBy" }),
}));

export const payrollPolicyVersionsRelations = relations(payrollPolicyVersions, ({ one, many }) => ({
  policy: one(payrollPolicies, { fields: [payrollPolicyVersions.policyId], references: [payrollPolicies.id] }),
  activations: many(payrollTemplateActivations),
  createdByUser: one(users, { fields: [payrollPolicyVersions.createdBy], references: [users.id], relationName: "policyVersionCreatedBy" }),
}));

export const payrollTemplateActivationsRelations = relations(payrollTemplateActivations, ({ one }) => ({
  policyVersion: one(payrollPolicyVersions, { fields: [payrollTemplateActivations.policyVersionId], references: [payrollPolicyVersions.id] }),
  activatedByUser: one(users, { fields: [payrollTemplateActivations.activatedBy], references: [users.id], relationName: "templateActivatedBy" }),
}));

export const payrollCalendarEventsRelations = relations(payrollCalendarEvents, ({ one }) => ({
  policy: one(payrollPolicies, { fields: [payrollCalendarEvents.policyId], references: [payrollPolicies.id] }),
  createdByUser: one(users, { fields: [payrollCalendarEvents.createdBy], references: [users.id], relationName: "calendarEventCreatedBy" }),
}));
