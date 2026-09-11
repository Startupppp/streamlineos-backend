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
  uuid,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { organizations, organizationMembers } from "../common/auth";
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
    spaceId: integer("space_id").notNull(),
    membershipId: integer("membership_id"),
    role: text("role"),
    team: text("team"),
    spaceRole: kbSpaceRoleEnum("space_role").default("viewer").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_kb_space_members_space").on(table.spaceId),
    index("idx_kb_space_members_org_membership").on(table.orgId, table.membershipId),
    index("idx_kb_space_members_org_role").on(table.orgId, table.role),
    index("idx_kb_space_members_org_space").on(table.orgId, table.spaceId),
    unique("uniq_kb_space_members_org_id").on(table.orgId, table.id),
    uniqueIndex("uniq_kb_space_members_org_space_membership")
      .on(table.orgId, table.spaceId, table.membershipId)
      .where(sql`${table.membershipId} IS NOT NULL`),
    uniqueIndex("uniq_kb_space_members_org_space_role")
      .on(table.orgId, table.spaceId, table.role)
      .where(sql`${table.role} IS NOT NULL`),
    foreignKey({ columns: [table.orgId, table.spaceId], foreignColumns: [kbSpaces.orgId, kbSpaces.id], name: "fk_kb_space_members_org_space" }),
    foreignKey({ columns: [table.orgId, table.membershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_kb_space_members_org_membership" }).onDelete("cascade"),
  ],
);

export const kbSpacesRelations = relations(kbSpaces, ({ one, many }) => ({
  organization: one(organizations, { fields: [kbSpaces.orgId], references: [organizations.id] }),
  createdByMember: one(organizationMembers, { fields: [kbSpaces.orgId, kbSpaces.createdByMembershipId], references: [organizationMembers.orgId, organizationMembers.id] }),
  members: many(kbSpaceMembers),
}));

export const kbSpaceMembersRelations = relations(kbSpaceMembers, ({ one }) => ({
  space: one(kbSpaces, { fields: [kbSpaceMembers.spaceId], references: [kbSpaces.id] }),
  membership: one(organizationMembers, { fields: [kbSpaceMembers.membershipId], references: [organizationMembers.id] }),
}));

/**
 * Per-principal grants on a single space, moved here from `common/access.ts`.
 *
 * It sat in the RBAC file because it is an access-control row, but the thing it
 * controls is a KB space: `space_id` is `kb_spaces.id`, and every reader of it is
 * in the knowledge module. Nothing in `common/access.ts` referenced it, so it was
 * a leaf in the wrong folder — the root barrel it is imported from is unchanged.
 *
 * `principal_type` / `principal_id` stay text rather than an FK: a grant can name
 * a user or a group, and the unique index carries the org so one tenant's grants
 * cannot collide with another's.
 */
export const kbSpaceGrants = pgTable(
  "kb_space_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    spaceId: integer("space_id").notNull(),
    principalType: text("principal_type").notNull().default("user"),
    principalId: text("principal_id").notNull(),
    permissionKey: text("permission_key").notNull(),
    grantedBy: text("granted_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uniq_kb_space_grants").on(
      t.orgId,
      t.spaceId,
      t.principalType,
      t.principalId,
      t.permissionKey,
    ),
    index("idx_kb_space_grants_org_space").on(t.orgId, t.spaceId),
    index("idx_kb_space_grants_principal").on(
      t.orgId,
      t.principalType,
      t.principalId,
    ),
  ],
);

export const kbSpaceGrantsRelations = relations(kbSpaceGrants, ({ one }) => ({
  organization: one(organizations, {
    fields: [kbSpaceGrants.orgId],
    references: [organizations.id],
  }),
  grantedByUser: one(users, {
    fields: [kbSpaceGrants.grantedBy],
    references: [users.id],
  }),
}));
