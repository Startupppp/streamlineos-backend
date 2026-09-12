/**
 * The canonical grant tables: what a person may do, and where it came from.
 *
 * A role assignment, the permission keys a role carries, the durable per-person
 * grants that hang off a membership rather than a role, and the version counter
 * every resolution is cached against. `resolveUserPermissions` reads this file
 * and `bumpPermissionsVersion` writes `access_versions`.
 *
 * The other two halves of the same question moved out: grants that arrive
 * through a group are in `./access-groups`, and which modules apply at all —
 * the entitlement that gates every key here — in `./access-modules`.
 */

import { pgTable, text, serial, integer, timestamp, index, uniqueIndex, pgEnum, uuid, foreignKey } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizationMembers, organizations, roles, permissions } from "./auth";
import { modulesCatalog } from "./modules";

export const dataScopeEnum = pgEnum("data_scope", [
  "all",
  "team",
  "own",
  "none",
]);

export const roleAssignments = pgTable(
  "role_assignments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    organizationMembershipId: integer("organization_membership_id").notNull(),
    roleId: integer("role_id")
      .notNull(),
    assignedByMembershipId: integer("assigned_by_membership_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    reason: text("reason"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_role_assignments_org_membership_role").on(
      table.orgId,
      table.organizationMembershipId,
      table.roleId,
    ),
    index("idx_role_assignments_org_role").on(table.orgId, table.roleId),
    foreignKey({
      columns: [table.orgId, table.organizationMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.orgId, table.roleId],
      foreignColumns: [roles.orgId, roles.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_role_assignments_assigner_membership",
      columns: [table.orgId, table.assignedByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    }).onDelete("set null"),
  ],
);

export const rolePermissionGrants = pgTable(
  "role_permission_grants",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    roleId: integer("role_id")
      .notNull(),
    permissionKey: text("permission_key")
      .references(() => permissions.name, { onDelete: "cascade" })
      .notNull(),
    scope: dataScopeEnum("scope").default("all").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_role_permission_grants_role_key").on(
      table.orgId,
      table.roleId,
      table.permissionKey,
    ),
    foreignKey({
      columns: [table.orgId, table.roleId],
      foreignColumns: [roles.orgId, roles.id],
    }).onDelete("cascade"),
  ],
);

export const userPermissionGrants = pgTable(
  "user_permission_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    organizationMembershipId: integer("organization_membership_id").notNull(),
    permissionKey: text("permission_key")
      .notNull(),
    scope: dataScopeEnum("scope").default("all").notNull(),
    moduleKey: text("module_key").notNull(),
    grantedByMembershipId: integer("granted_by_membership_id"),
    reason: text("reason"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_user_permission_grants_membership_key").on(
      table.orgId,
      table.organizationMembershipId,
      table.permissionKey,
    ),
    index("idx_user_permission_grants_org_module").on(
      table.orgId,
      table.moduleKey,
    ),
    foreignKey({
      columns: [table.orgId, table.organizationMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_user_permission_grants_granter_membership",
      columns: [table.orgId, table.grantedByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    }).onDelete("set null"),
    foreignKey({
      name: "fk_user_permission_grants_module",
      columns: [table.moduleKey],
      foreignColumns: [modulesCatalog.moduleKey],
    }),
    foreignKey({
      name: "fk_user_permission_grants_permission_module",
      columns: [table.permissionKey, table.moduleKey],
      foreignColumns: [permissions.name, permissions.administeringModuleKey],
    }),
  ],
);

export const accessVersions = pgTable("access_versions", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  permissionsVersion: integer("permissions_version").default(1).notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export const roleAssignmentsRelations = relations(
  roleAssignments,
  ({ one }) => ({
    organization: one(organizations, {
      fields: [roleAssignments.orgId],
      references: [organizations.id],
    }),
    membership: one(organizationMembers, {
      fields: [roleAssignments.orgId, roleAssignments.organizationMembershipId],
      references: [organizationMembers.orgId, organizationMembers.id],
    }),
    role: one(roles, {
      fields: [roleAssignments.roleId],
      references: [roles.id],
    }),
  }),
);

export const rolePermissionGrantsRelations = relations(
  rolePermissionGrants,
  ({ one }) => ({
    organization: one(organizations, {
      fields: [rolePermissionGrants.orgId],
      references: [organizations.id],
    }),
    role: one(roles, {
      fields: [rolePermissionGrants.roleId],
      references: [roles.id],
    }),
    permission: one(permissions, {
      fields: [rolePermissionGrants.permissionKey],
      references: [permissions.name],
    }),
  }),
);

export const accessVersionsRelations = relations(accessVersions, ({ one }) => ({
  organization: one(organizations, {
    fields: [accessVersions.orgId],
    references: [organizations.id],
  }),
}));
