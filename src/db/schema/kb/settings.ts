import { pgTable, serial, text, integer, boolean, timestamp, uniqueIndex, unique, check } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { organizations } from "../common/auth";

export const kbSettings = pgTable(
  "kb_settings",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    trashRetentionDays: integer("trash_retention_days").notNull().default(30),
    chatHistoryRetentionDays: integer("chat_history_retention_days").default(90),
    hrmsKbLinkEnabled: boolean("hrms_kb_link_enabled").notNull().default(false),
    hrmsKbSearchEnabled: boolean("hrms_kb_search_enabled").notNull().default(false),
    hrmsKbAiEnabled: boolean("hrms_kb_ai_enabled").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_kb_settings_org").on(table.orgId),
    unique("uniq_kb_settings_org_id").on(table.orgId, table.id),
    check(
      "chk_kb_settings_hrms_flag_order",
      sql`(NOT ${table.hrmsKbSearchEnabled} OR ${table.hrmsKbLinkEnabled}) AND (NOT ${table.hrmsKbAiEnabled} OR ${table.hrmsKbSearchEnabled})`,
    ),
  ],
);

export const kbSettingsRelations = relations(kbSettings, ({ one }) => ({
  organization: one(organizations, { fields: [kbSettings.orgId], references: [organizations.id] }),
}));
