import { pgTable, serial, text, jsonb, timestamp, index, unique } from "drizzle-orm/pg-core";
import { organizations, users } from "../auth";

export const SETTINGS_AUDIT_ENTITY_TYPES = [
  "sla_policy",
  "business_hours",
  "automation",
  "channel",
  "custom_field",
  "routing_rule",
  "agent_skill",
  "agent_availability",
  "vip_client",
] as const;
export type SettingsAuditEntityType = (typeof SETTINGS_AUDIT_ENTITY_TYPES)[number];

export const SETTINGS_AUDIT_ACTIONS = ["created", "updated", "deleted"] as const;
export type SettingsAuditAction = (typeof SETTINGS_AUDIT_ACTIONS)[number];

export const supportSettingsAuditLog = pgTable(
  "support_settings_audit_log",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    userId: text("user_id").references(() => users.id),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    changes: jsonb("changes").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_support_settings_audit_log_org_created").on(table.orgId, table.createdAt),
    index("idx_support_settings_audit_log_org_entity").on(table.orgId, table.entityType),
    unique("uniq_support_settings_audit_org_id").on(table.orgId, table.id),
  ],
);
