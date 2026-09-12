/**
 * Grants that arrive through a group rather than through a person.
 *
 * A principal group, its members, and the roles assigned to the group. This is
 * the second of the four sources `computeUserPermissions` unions — direct role
 * assignments, permission-group roles, unexpired delegations and module
 * ownership — and it is the only one whose membership is itself a tenant-scoped
 * row that a revocation has to clear.
 *
 * Split out of `access.ts` verbatim; nothing here is referenced by the direct
 * grant tables, so the file is a leaf and adds no edge back.
 */

import { pgTable, text, integer, timestamp, index, uniqueIndex, uuid, foreignKey } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizationMembers, organizations, roles } from "./auth";
import { orgUnits } from "./organization";

export type PrincipalGroupKind = "ORG_UNIT" | "CUSTOM";

export const principalGroups = pgTable(
  "principal_groups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    kind: text("kind").$type<PrincipalGroupKind>().notNull(),
    orgUnitId: text("org_unit_id").references(() => orgUnits.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_principal_groups_org_name").on(table.orgId, table.name),
    uniqueIndex("uniq_principal_groups_org_id").on(table.orgId, table.id),
    index("idx_principal_groups_org").on(table.orgId),
    index("idx_principal_groups_org_unit").on(table.orgUnitId),
  ],
);

export const principalGroupMembers = pgTable(
  "principal_group_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    principalGroupId: uuid("principal_group_id")
      .references(() => principalGroups.id, { onDelete: "cascade" })
      .notNull(),
    organizationMembershipId: integer("organization_membership_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_principal_group_members_group_member").on(
      table.principalGroupId,
      table.organizationMembershipId,
    ),
    index("idx_principal_group_members_org_member").on(
      table.orgId,
      table.organizationMembershipId,
    ),
    index("idx_principal_group_members_group").on(table.principalGroupId),
    foreignKey({
      columns: [table.orgId, table.organizationMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.orgId, table.principalGroupId],
      foreignColumns: [principalGroups.orgId, principalGroups.id],
    }).onDelete("cascade"),
  ],
);

export const groupRoleAssignments = pgTable(
  "group_role_assignments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    principalGroupId: uuid("principal_group_id")
      .references(() => principalGroups.id, { onDelete: "cascade" })
      .notNull(),
    roleId: integer("role_id")
      .references(() => roles.id, { onDelete: "cascade" })
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_group_role_assignments_group_role").on(
      table.orgId,
      table.principalGroupId,
      table.roleId,
    ),
    index("idx_group_role_assignments_org_group").on(
      table.orgId,
      table.principalGroupId,
    ),
    foreignKey({
      columns: [table.orgId, table.principalGroupId],
      foreignColumns: [principalGroups.orgId, principalGroups.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.orgId, table.roleId],
      foreignColumns: [roles.orgId, roles.id],
    }).onDelete("cascade"),
  ],
);

export const principalGroupsRelations = relations(
  principalGroups,
  ({ one, many }) => ({
    organization: one(organizations, {
      fields: [principalGroups.orgId],
      references: [organizations.id],
    }),
    orgUnit: one(orgUnits, {
      fields: [principalGroups.orgUnitId],
      references: [orgUnits.id],
    }),
    members: many(principalGroupMembers),
    roleAssignments: many(groupRoleAssignments),
  }),
);

export const principalGroupMembersRelations = relations(
  principalGroupMembers,
  ({ one }) => ({
    organization: one(organizations, {
      fields: [principalGroupMembers.orgId],
      references: [organizations.id],
    }),
    principalGroup: one(principalGroups, {
      fields: [principalGroupMembers.principalGroupId],
      references: [principalGroups.id],
    }),
    membership: one(organizationMembers, {
      fields: [
        principalGroupMembers.orgId,
        principalGroupMembers.organizationMembershipId,
      ],
      references: [organizationMembers.orgId, organizationMembers.id],
    }),
  }),
);

export const groupRoleAssignmentsRelations = relations(
  groupRoleAssignments,
  ({ one }) => ({
    organization: one(organizations, {
      fields: [groupRoleAssignments.orgId],
      references: [organizations.id],
    }),
    principalGroup: one(principalGroups, {
      fields: [groupRoleAssignments.principalGroupId],
      references: [principalGroups.id],
    }),
    role: one(roles, {
      fields: [groupRoleAssignments.roleId],
      references: [roles.id],
    }),
  }),
);
