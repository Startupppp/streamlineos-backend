import { pgTable, serial, text, integer, boolean, jsonb, timestamp, index, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../auth";
import { signTemplateStatusEnum } from "./enums";

export const signTemplates = pgTable(
  "sign_templates",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    name: text("name").notNull(),
    description: text("description"),
    category: text("category"),
    status: signTemplateStatusEnum("status").default("draft").notNull(),
    ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    version: integer("version").default(1).notNull(),
    // Snapshot of documents/roles/fields/routing/reminders/expiration/auth/watermark/merge-field config.
    templateJson: jsonb("template_json").$type<Record<string, unknown>>().default({}).notNull(),
    restrictedToRoles: jsonb("restricted_to_roles").$type<string[]>().default([]).notNull(),
    restrictedToTeams: jsonb("restricted_to_teams").$type<string[]>().default([]).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_sign_templates_org_status").on(table.orgId, table.status),
    uniqueIndex("uniq_sign_templates_org_name_version").on(table.orgId, table.name, table.version),
    unique("uniq_sign_templates_org_id").on(table.orgId, table.id),
  ],
);

export const signTemplatesRelations = relations(signTemplates, ({ one }) => ({
  organization: one(organizations, { fields: [signTemplates.orgId], references: [organizations.id] }),
  owner: one(users, { fields: [signTemplates.ownerUserId], references: [users.id] }),
}));
