import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../auth";
import { kbAudienceEnum, kbSpaceRoleEnum } from "../enums";

export const kbSpaces = pgTable(
  "kb_spaces",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    audience: kbAudienceEnum("audience").default("internal").notNull(),
    icon: text("icon"),
    branding: jsonb("branding").$type<Record<string, unknown>>(),
    isPublicHelpCenter: boolean("is_public_help_center").default(false).notNull(),
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    index("idx_kb_spaces_org").on(table.orgId),
    uniqueIndex("uniq_kb_spaces_org_slug").on(table.orgId, table.slug),
  ],
);

export const kbSpaceMembers = pgTable(
  "kb_space_members",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    spaceId: integer("space_id").references(() => kbSpaces.id, { onDelete: "cascade" }).notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    role: text("role"),
    team: text("team"),
    spaceRole: kbSpaceRoleEnum("space_role").default("viewer").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_kb_space_members_space").on(table.spaceId),
    index("idx_kb_space_members_user").on(table.userId),
    index("idx_kb_space_members_org_role").on(table.orgId, table.role),
  ],
);

export const kbSpacesRelations = relations(kbSpaces, ({ one, many }) => ({
  organization: one(organizations, { fields: [kbSpaces.orgId], references: [organizations.id] }),
  createdBy: one(users, { fields: [kbSpaces.createdById], references: [users.id] }),
  members: many(kbSpaceMembers),
}));

export const kbSpaceMembersRelations = relations(kbSpaceMembers, ({ one }) => ({
  space: one(kbSpaces, { fields: [kbSpaceMembers.spaceId], references: [kbSpaces.id] }),
  user: one(users, { fields: [kbSpaceMembers.userId], references: [users.id] }),
}));
