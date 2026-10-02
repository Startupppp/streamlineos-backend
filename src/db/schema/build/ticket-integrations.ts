import { boolean, foreignKey, index, integer, jsonb, text, timestamp, unique, varchar } from "drizzle-orm/pg-core";
import { build } from "./namespaces";
import { organizations, users } from "../common/auth";
import { projects } from "./core";

export const projectWebhooks = build.table(
  "project_webhooks",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: integer("project_id")
      .notNull()
      ,
    url: text("url").notNull(),
    events: text("events").array().notNull().default([]),
    secretSetAt: timestamp("secret_set_at", { withTimezone: true }),
    integrationsEndpointId: integer("integrations_endpoint_id"),
    isActive: boolean("is_active").notNull().default(true),
    version: integer("version").notNull().default(1),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
  foreignKey({ columns: [t.orgId, t.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_project_webhooks_org_project" }).onDelete("cascade"),
    index("idx_project_webhooks_project_id").on(t.projectId),
    unique("uniq_project_webhooks_org_id").on(t.orgId, t.id),
  ],
);

export const projectAutomations = build.table(
  "project_automations",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    projectId: integer("project_id")
      .notNull()
      ,
    name: varchar("name", { length: 200 }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    triggerEvent: varchar("trigger_event", { length: 100 }).notNull(),
    conditions: jsonb("conditions")
      .$type<
        Array<{
          field: string;
          operator:
            | "equals"
            | "not_equals"
            | "contains"
            | "is_empty"
            | "is_not_empty";
          value?: string;
        }>
      >()
      .notNull()
      .default([]),
    actions: jsonb("actions")
      .$type<
        Array<{
          type:
            | "set_status"
            | "set_assignee"
            | "set_priority"
            | "add_label"
            | "add_comment";
          value: string;
        }>
      >()
      .notNull()
      .default([]),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
  },
  (t) => [
  foreignKey({ columns: [t.orgId, t.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_project_automations_org_project" }).onDelete("cascade"),
    index("idx_project_automations_project_id").on(t.projectId),
    unique("uniq_project_automations_org_id").on(t.orgId, t.id),
  ],
);
