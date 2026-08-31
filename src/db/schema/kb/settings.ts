import { pgTable, serial, text, integer, timestamp, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../common/auth";

export const kbSettings = pgTable(
  "kb_settings",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    trashRetentionDays: integer("trash_retention_days").notNull().default(30),
    chatHistoryRetentionDays: integer("chat_history_retention_days").default(90),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_kb_settings_org").on(table.orgId),
    unique("uniq_kb_settings_org_id").on(table.orgId, table.id),
  ],
);

export const kbSettingsRelations = relations(kbSettings, ({ one }) => ({
  organization: one(organizations, { fields: [kbSettings.orgId], references: [organizations.id] }),
}));
