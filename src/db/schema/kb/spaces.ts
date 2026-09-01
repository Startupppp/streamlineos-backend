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
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { organizations, users, organizationMembers } from "../common/auth";
import { kbAudienceEnum, kbSpaceRoleEnum } from "../common/enums";

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
    createdByMembershipId: integer("created_by_membership_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at"),
    type: text("type").notNull().default("team").$type<"private" | "team" | "company" | "module" | "support" | "project">(),
    color: text("color"),
    defaultVisibility: text("default_visibility").notNull().default("org"),
    owningTeamId: text("owning_team_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_kb_spaces_org").on(table.orgId),
    index("idx_kb_spaces_org_live").on(table.orgId).where(sql`${table.deletedAt} IS NULL`),
    index("idx_kb_spaces_org_created_by_mbr").on(table.orgId, table.createdByMembershipId),
    uniqueIndex("uniq_kb_spaces_org_slug").on(table.orgId, table.slug),
    unique("uniq_kb_spaces_org_id").on(table.orgId, table.id),
    foreignKey({ columns: [table.orgId, table.createdByMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_kb_spaces_org_created_by_mbr" }).onDelete("set null"),
  ],
);

export const kbSpaceMembers = pgTable(
  "kb_space_members",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    spaceId: integer("space_id").references(() => kbSpaces.id, { onDelete: "cascade" }).notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    membershipId: integer("membership_id"),
    role: text("role"),
    team: text("team"),
    spaceRole: kbSpaceRoleEnum("space_role").default("viewer").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_kb_space_members_space").on(table.spaceId),
    index("idx_kb_space_members_user").on(table.userId),
    index("idx_kb_space_members_org_membership").on(table.orgId, table.membershipId),
    index("idx_kb_space_members_org_role").on(table.orgId, table.role),
    index("idx_kb_space_members_org_space").on(table.orgId, table.spaceId),
    unique("uniq_kb_space_members_org_id").on(table.orgId, table.id),
    foreignKey({ columns: [table.orgId, table.spaceId], foreignColumns: [kbSpaces.orgId, kbSpaces.id], name: "fk_kb_space_members_org_space" }),
    foreignKey({ columns: [table.orgId, table.membershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_kb_space_members_org_membership" }).onDelete("set null"),
  ],
);

export const kbSpacesRelations = relations(kbSpaces, ({ one, many }) => ({
  organization: one(organizations, { fields: [kbSpaces.orgId], references: [organizations.id] }),
  createdBy: one(users, { fields: [kbSpaces.createdById], references: [users.id] }),
  createdByMember: one(organizationMembers, { fields: [kbSpaces.orgId, kbSpaces.createdByMembershipId], references: [organizationMembers.orgId, organizationMembers.id] }),
  members: many(kbSpaceMembers),
}));

export const kbSpaceMembersRelations = relations(kbSpaceMembers, ({ one }) => ({
  space: one(kbSpaces, { fields: [kbSpaceMembers.spaceId], references: [kbSpaces.id] }),
  user: one(users, { fields: [kbSpaceMembers.userId], references: [users.id] }),
  membership: one(organizationMembers, { fields: [kbSpaceMembers.membershipId], references: [organizationMembers.id] }),
}));
