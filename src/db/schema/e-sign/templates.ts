import { pgTable, serial, text, integer, jsonb, timestamp, index, uniqueIndex, unique, foreignKey } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users, organizationMembers } from "../common/auth";
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
    ownerMembershipId: integer("owner_membership_id"),
    version: integer("version").default(1).notNull(),
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
    foreignKey({
      columns: [table.orgId, table.ownerMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_sign_tpl_org_owner_mbr",
    }).onDelete("set null"),
  ],
);

export const signTemplatesRelations = relations(signTemplates, ({ one }) => ({
  organization: one(organizations, { fields: [signTemplates.orgId], references: [organizations.id] }),
  owner: one(users, { fields: [signTemplates.ownerUserId], references: [users.id] }),
  ownerMember: one(organizationMembers, {
    fields: [signTemplates.orgId, signTemplates.ownerMembershipId],
    references: [organizationMembers.orgId, organizationMembers.id],
  }),
}));
