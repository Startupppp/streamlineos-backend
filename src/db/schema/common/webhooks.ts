import { pgTable, text, serial, timestamp, boolean, jsonb, integer, index, unique } from "drizzle-orm/pg-core";
import { organizations, users } from "./auth";

export const webhookEndpoints = pgTable("webhook_endpoints", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  url: text("url").notNull(),
  secret: text("secret").notNull(),
  description: text("description"),
  events: jsonb("events").$type<string[]>().default([]).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_webhook_endpoints_org").on(table.orgId),
  unique("uniq_webhook_endpoints_org_id").on(table.orgId, table.id),
]);

export const webhookLogs = pgTable("webhook_logs", {
  id: serial("id").primaryKey(),
  endpointId: integer("endpoint_id").references(() => webhookEndpoints.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  event: text("event").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  statusCode: integer("status_code"),
  responseBody: text("response_body"),
  attempt: integer("attempt").default(1).notNull(),
  success: boolean("success").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_webhook_logs_endpoint").on(table.endpointId),
  index("idx_webhook_logs_org_event").on(table.orgId, table.event),
  unique("uniq_webhook_logs_org_id").on(table.orgId, table.id),
]);
