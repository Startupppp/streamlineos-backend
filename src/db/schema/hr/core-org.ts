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
  unique,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../common/auth";
import { hrEmployments } from "./core-people";
import { customFieldDefinitions } from "../custom-field-engine";

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
  unique("uniq_hr_job_roles_org_id").on(table.orgId, table.id),
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
  unique("uniq_hr_job_levels_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_hr_job_levels_org_name").on(table.orgId, table.name),
  index("idx_hr_job_levels_org").on(table.orgId),
]);

export const hrEmploymentCustomFieldValues = pgTable(
  "hr_employment_custom_field_values",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    employmentId: integer("employment_id")
      .references(() => hrEmployments.id, { onDelete: "cascade" })
      .notNull(),
    fieldDefinitionId: integer("field_definition_id")
      .references(() => customFieldDefinitions.id, { onDelete: "cascade" })
      .notNull(),
    value: jsonb("value"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_hr_ecfv_employment_field").on(
      table.employmentId,
      table.fieldDefinitionId,
    ),
    index("idx_hr_ecfv_org_employment").on(table.orgId, table.employmentId),
    unique("uniq_hr_ecfv_org_id").on(table.orgId, table.id),
  ],
);

export const hrJobRolesRelations = relations(hrJobRoles, ({ one }) => ({
  org: one(organizations, { fields: [hrJobRoles.orgId], references: [organizations.id] }),
}));

export const hrJobLevelsRelations = relations(hrJobLevels, ({ one }) => ({
  org: one(organizations, { fields: [hrJobLevels.orgId], references: [organizations.id] }),
}));
