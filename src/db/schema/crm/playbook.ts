import { pgTable, text, serial, integer, timestamp, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../auth";

export const playbookEntries = pgTable("playbook_entries", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  category: text("category"),
  content: text("content").default("").notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_playbook_entries_org").on(table.orgId),
]);

export const playbookEntriesRelations = relations(playbookEntries, ({ one }) => ({
  organization: one(organizations, { fields: [playbookEntries.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [playbookEntries.createdBy], references: [users.id] }),
}));
