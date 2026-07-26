import { pgTable, text, boolean, integer, jsonb, timestamp, index, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import { organizations } from "../auth";

export const crmPipelines = pgTable("crm_pipelines", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  type: text("type"),
  key: text("key").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  isDefault: boolean("is_default").default(false).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  uniqueIndex("uniq_crm_pipelines_org_key").on(table.orgId, table.key),
  unique("uniq_crm_pipelines_org_id").on(table.orgId, table.id),
]);

export const crmPipelineStages = pgTable("crm_pipeline_stages", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  pipelineId: text("pipeline_id").references(() => crmPipelines.id, { onDelete: "cascade" }).notNull(),
  key: text("key").notNull(),
  label: text("label").notNull(),
  description: text("description"),
  color: text("color"),
  icon: text("icon"),
  sortOrder: integer("sort_order").default(0).notNull(),
  probability: integer("probability").default(0).notNull(),
  stageType: text("stage_type").default("open").notNull(),
  isTerminal: boolean("is_terminal").default(false).notNull(),
  slaHours: integer("sla_hours"),
  requiresApproval: boolean("requires_approval").default(false).notNull(),
  requiredFields: jsonb("required_fields").$type<string[]>(),
  allowedNextStageKeys: jsonb("allowed_next_stage_keys").$type<string[] | null>(),
  isActive: boolean("is_active").default(true).notNull(),
  isSystemDefault: boolean("is_system_default").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_crm_pipeline_stages_org_pipeline_key").on(table.orgId, table.pipelineId, table.key),
  index("idx_crm_pipeline_stages_org_pipeline_sort").on(table.orgId, table.pipelineId, table.sortOrder),
  unique("uniq_crm_pipeline_stages_org_id").on(table.orgId, table.id),
]);

export const crmOptions = pgTable("crm_options", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  type: text("type").notNull(),
  key: text("key").notNull(),
  label: text("label").notNull(),
  description: text("description"),
  color: text("color"),
  icon: text("icon"),
  sortOrder: integer("sort_order").default(0).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  isSystemDefault: boolean("is_system_default").default(false).notNull(),
  isTerminal: boolean("is_terminal").default(false).notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_crm_options_org_type_key").on(table.orgId, table.type, table.key),
  index("idx_crm_options_org_type_active").on(table.orgId, table.type, table.isActive),
  unique("uniq_crm_options_org_id").on(table.orgId, table.id),
]);

export const crmValidationRules = pgTable("crm_validation_rules", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  entityType: text("entity_type").notNull(),
  field: text("field").notNull(),
  ruleType: text("rule_type").notNull(),
  config: jsonb("config").$type<Record<string, unknown>>(),
  pipelineId: text("pipeline_id"),
  stageKey: text("stage_key"),
  sourceKey: text("source_key"),
  errorMessage: text("error_message"),
  isActive: boolean("is_active").default(true).notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_crm_validation_rules_org_entity_active").on(table.orgId, table.entityType, table.isActive),
  unique("uniq_crm_validation_rules_org_id").on(table.orgId, table.id),
]);

export const crmBlueprints = pgTable("crm_blueprints", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  pipelineId: text("pipeline_id").references(() => crmPipelines.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_crm_blueprints_org_pipeline").on(table.orgId, table.pipelineId),
  unique("uniq_crm_blueprints_org_id").on(table.orgId, table.id),
]);

export const crmBlueprintTransitions = pgTable("crm_blueprint_transitions", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  blueprintId: text("blueprint_id").references(() => crmBlueprints.id, { onDelete: "cascade" }).notNull(),
  fromStageKey: text("from_stage_key").notNull(),
  toStageKey: text("to_stage_key").notNull(),
  requiredFields: jsonb("required_fields").$type<string[]>(),
  requiredActivityTypeKeys: jsonb("required_activity_type_keys").$type<string[]>(),
  requiresApproval: boolean("requires_approval").default(false).notNull(),
  requiresQuote: boolean("requires_quote").default(false).notNull(),
  autoTaskTemplates: jsonb("auto_task_templates").$type<Record<string, unknown>[]>(),
  sortOrder: integer("sort_order").default(0).notNull(),
}, (table) => [
  index("idx_crm_blueprint_transitions_org_blueprint").on(table.orgId, table.blueprintId),
  unique("uniq_crm_blueprint_trans_org_id").on(table.orgId, table.id),
]);

export const crmAutomationEvents = pgTable("crm_automation_events", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  key: text("key").notNull(),
  label: text("label").notNull(),
  description: text("description"),
  entityType: text("entity_type").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  isSystemDefault: boolean("is_system_default").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_crm_automation_events_org_key").on(table.orgId, table.key),
  unique("uniq_crm_automation_events_org_id").on(table.orgId, table.id),
]);

export const crmAutomationActions = pgTable("crm_automation_actions", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  key: text("key").notNull(),
  label: text("label").notNull(),
  description: text("description"),
  configSchema: jsonb("config_schema").$type<Record<string, unknown> | null>(),
  isActive: boolean("is_active").default(true).notNull(),
  isSystemDefault: boolean("is_system_default").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_crm_automation_actions_org_key").on(table.orgId, table.key),
  unique("uniq_crm_automation_actions_org_id").on(table.orgId, table.id),
]);

export const crmUiMetadata = pgTable("crm_ui_metadata", {
  id: text("id").primaryKey().$defaultFn(() => randomUUID()),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  scope: text("scope").notNull(),
  config: jsonb("config").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_crm_ui_metadata_org_scope").on(table.orgId, table.scope),
  unique("uniq_crm_ui_metadata_org_id").on(table.orgId, table.id),
]);
