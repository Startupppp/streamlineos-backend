import {
  text,
  bigserial,
  timestamp,
  boolean,
  integer,
  index,
  unique,
  jsonb,
  varchar,
  check,
} from "drizzle-orm/pg-core";
import { build } from "./namespaces";
import { sql } from "drizzle-orm";
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
      .references(() => projects.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    events: text("events").array().notNull().default([]),
    secret: text("secret"),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_project_webhooks_project_id").on(t.projectId),
    index("idx_project_webhooks_org_id").on(t.orgId),
    unique("uniq_project_webhooks_org_id").on(t.orgId, t.id),
  ],
);

export const webhookDeliveries = build.table(
  "webhook_deliveries",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    webhookId: integer("webhook_id")
      .notNull()
      .references(() => projectWebhooks.id, { onDelete: "cascade" }),
    event: varchar("event", { length: 100 }).notNull(),
    payload: jsonb("payload"),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    responseCode: integer("response_code"),
    responseBody: text("response_body"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_webhook_deliveries_webhook_id").on(t.webhookId),
    index("idx_webhook_deliveries_delivered_at").on(t.deliveredAt),
    check(
      "chk_webhook_deliveries_status",
      sql`${t.status} IN ('pending','success','failed')`,
    ),
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
      .references(() => projects.id, { onDelete: "cascade" }),
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
  },
  (t) => [
    index("idx_project_automations_project_id").on(t.projectId),
    index("idx_project_automations_org_id").on(t.orgId),
    unique("uniq_project_automations_org_id").on(t.orgId, t.id),
  ],
);
