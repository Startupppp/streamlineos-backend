import { pgTable, text, serial, integer, timestamp, index, uniqueIndex, pgEnum } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users, roles, permissions } from "./auth";

export const dataScopeEnum = pgEnum("data_scope", ["all", "team", "own", "none"]);
export const principalGroupTypeEnum = pgEnum("principal_group_type", ["department"]);

export const userRoles = pgTable("user_roles", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  roleId: integer("role_id").references(() => roles.id, { onDelete: "cascade" }).notNull(),
  assignedBy: text("assigned_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_user_roles_org_user_role").on(table.orgId, table.userId, table.roleId),
  index("idx_user_roles_org_user").on(table.orgId, table.userId),
]);

export const rolePermissionGrants = pgTable("role_permission_grants", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  roleId: integer("role_id").references(() => roles.id, { onDelete: "cascade" }).notNull(),
  permissionKey: text("permission_key").references(() => permissions.name, { onDelete: "cascade" }).notNull(),
  scope: dataScopeEnum("scope").default("all").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_role_permission_grants_role_key").on(table.roleId, table.permissionKey),
  index("idx_role_permission_grants_org_role").on(table.orgId, table.roleId),
]);

export const groupRoles = pgTable("group_roles", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  groupType: principalGroupTypeEnum("group_type").notNull(),
  groupId: integer("group_id").notNull(),
  roleId: integer("role_id").references(() => roles.id, { onDelete: "cascade" }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_group_roles_org_group_role").on(table.orgId, table.groupType, table.groupId, table.roleId),
  index("idx_group_roles_org_group").on(table.orgId, table.groupType, table.groupId),
]);

export const accessVersions = pgTable("access_versions", {
  orgId: text("org_id").primaryKey().references(() => organizations.id, { onDelete: "cascade" }),
  permissionsVersion: integer("permissions_version").default(1).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export const userRolesRelations = relations(userRoles, ({ one }) => ({
  organization: one(organizations, {
    fields: [userRoles.orgId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [userRoles.userId],
    references: [users.id],
  }),
  role: one(roles, {
    fields: [userRoles.roleId],
    references: [roles.id],
  }),
  assigner: one(users, {
    fields: [userRoles.assignedBy],
    references: [users.id],
  }),
}));

export const rolePermissionGrantsRelations = relations(rolePermissionGrants, ({ one }) => ({
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
}));

export const groupRolesRelations = relations(groupRoles, ({ one }) => ({
  organization: one(organizations, {
    fields: [groupRoles.orgId],
    references: [organizations.id],
  }),
  role: one(roles, {
    fields: [groupRoles.roleId],
    references: [roles.id],
  }),
}));

export const accessVersionsRelations = relations(accessVersions, ({ one }) => ({
  organization: one(organizations, {
    fields: [accessVersions.orgId],
    references: [organizations.id],
  }),
}));

export type UserRole = typeof userRoles.$inferSelect;
export type RolePermissionGrant = typeof rolePermissionGrants.$inferSelect;
export type GroupRole = typeof groupRoles.$inferSelect;
export type AccessVersion = typeof accessVersions.$inferSelect;
