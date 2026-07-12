import {
  pgTable,
  text,
  serial,
  timestamp,
  boolean,
  jsonb,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../auth";
import { hrCustomFieldTypeEnum } from "./core-people";

export const hrJobRoles = pgTable("hr_job_roles", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  code: text("code"),
  description: text("description"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_hr_job_roles_org_name").on(table.orgId, table.name),
  index("idx_hr_job_roles_org").on(table.orgId),
]);

export const hrJobLevels = pgTable("hr_job_levels", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  code: text("code"),
  grade: text("grade"),
  rank: integer("rank").default(0).notNull(),
  description: text("description"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_hr_job_levels_org_name").on(table.orgId, table.name),
  index("idx_hr_job_levels_org").on(table.orgId),
]);

export const hrEmploymentTypes = pgTable("hr_employment_types", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  code: text("code"),
  description: text("description"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_hr_employment_types_org_name").on(table.orgId, table.name),
  index("idx_hr_employment_types_org").on(table.orgId),
]);

export const hrTeams = pgTable("hr_teams", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  code: text("code"),
  description: text("description"),
  leadUserId: text("lead_user_id").references(() => users.id, { onDelete: "set null" }),
  parentTeamId: integer("parent_team_id"),
  isActive: boolean("is_active").default(true).notNull(),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_hr_teams_org_name").on(table.orgId, table.name),
  index("idx_hr_teams_org").on(table.orgId),
]);

export const hrLocations = pgTable("hr_locations", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  code: text("code"),
  type: text("type").default("OFFICE"),
  address: jsonb("address").$type<{
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    country?: string;
    postalCode?: string;
    timezone?: string;
  }>(),
  isActive: boolean("is_active").default(true).notNull(),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_hr_locations_org_name").on(table.orgId, table.name),
  index("idx_hr_locations_org").on(table.orgId),
]);

export const hrCustomFieldDefinitions = pgTable("hr_custom_field_definitions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  entityType: text("entity_type").notNull(),
  name: text("name").notNull(),
  key: text("key").notNull(),
  fieldType: hrCustomFieldTypeEnum("field_type").notNull(),
  options: jsonb("options").$type<Array<{ label: string; value: string }>>(),
  settings: jsonb("settings").$type<{
    helpText?: string;
    placeholder?: string;
    defaultValue?: unknown;
    validationRules?: {
      minLength?: number;
      maxLength?: number;
      minValue?: number;
      maxValue?: number;
      allowedOptions?: string[];
      dateMin?: string;
      dateMax?: string;
    };
    visibility?: {
      hrOnly?: boolean;
      managerVisible?: boolean;
      selfServiceVisible?: boolean;
      hiddenFromExports?: boolean;
    };
    searchable?: boolean;
    reportable?: boolean;
  }>(),
  isSensitive: boolean("is_sensitive").default(false).notNull(),
  isRequired: boolean("is_required").default(false).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  displayOrder: integer("display_order").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_hr_cfd_org_entity_key").on(table.orgId, table.entityType, table.key),
  index("idx_hr_cfd_org_entity").on(table.orgId, table.entityType),
]);

export const hrCustomFieldValues = pgTable("hr_custom_field_values", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  fieldDefinitionId: integer("field_definition_id").references(() => hrCustomFieldDefinitions.id, { onDelete: "cascade" }).notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  value: jsonb("value"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_hr_cfv_field_entity").on(table.fieldDefinitionId, table.entityType, table.entityId),
  index("idx_hr_cfv_org_entity").on(table.orgId, table.entityType, table.entityId),
]);

export const hrJobRolesRelations = relations(hrJobRoles, ({ one }) => ({
  org: one(organizations, { fields: [hrJobRoles.orgId], references: [organizations.id] }),
}));

export const hrJobLevelsRelations = relations(hrJobLevels, ({ one }) => ({
  org: one(organizations, { fields: [hrJobLevels.orgId], references: [organizations.id] }),
}));

export const hrEmploymentTypesRelations = relations(hrEmploymentTypes, ({ one }) => ({
  org: one(organizations, { fields: [hrEmploymentTypes.orgId], references: [organizations.id] }),
}));

export const hrTeamsRelations = relations(hrTeams, ({ one }) => ({
  org: one(organizations, { fields: [hrTeams.orgId], references: [organizations.id] }),
  lead: one(users, { fields: [hrTeams.leadUserId], references: [users.id] }),
}));

export const hrLocationsRelations = relations(hrLocations, ({ one }) => ({
  org: one(organizations, { fields: [hrLocations.orgId], references: [organizations.id] }),
}));
