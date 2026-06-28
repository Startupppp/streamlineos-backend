import { pgTable, text, serial, integer, timestamp, index, uniqueIndex, pgEnum, uuid, varchar, boolean } from "drizzle-orm/pg-core";
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
  expiresAt: timestamp("expires_at"),
  reason: text("reason"),
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

export const orgModules = pgTable(
  "org_modules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: varchar("org_id", { length: 36 }).notNull(),
    moduleKey: varchar("module_key", { length: 64 }).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    enabledAt: timestamp("enabled_at").defaultNow().notNull(),
    enabledBy: varchar("enabled_by", { length: 36 }),
  },
  (t) => [
    uniqueIndex("org_modules_unique_idx").on(t.orgId, t.moduleKey),
    index("org_modules_org_idx").on(t.orgId),
  ],
);

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

export const resourceGrants = pgTable(
  "resource_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: varchar("org_id", { length: 36 }).notNull(),
    resourceType: varchar("resource_type", { length: 64 }).notNull(),
    resourceId: varchar("resource_id", { length: 36 }).notNull(),
    principalType: varchar("principal_type", { length: 16 }).notNull().default("user"),
    principalId: varchar("principal_id", { length: 36 }).notNull(),
    permissionKey: varchar("permission_key", { length: 128 }).notNull(),
    grantedBy: varchar("granted_by", { length: 36 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("resource_grants_unique_idx").on(
      t.orgId, t.resourceType, t.resourceId, t.principalType, t.principalId, t.permissionKey,
    ),
    index("resource_grants_org_resource_idx").on(t.orgId, t.resourceType, t.resourceId),
    index("resource_grants_principal_idx").on(t.orgId, t.principalType, t.principalId),
  ],
);

export const resourceGrantsRelations = relations(resourceGrants, ({ one }) => ({
  organization: one(organizations, {
    fields: [resourceGrants.orgId],
    references: [organizations.id],
  }),
}));

export type UserRole = typeof userRoles.$inferSelect;
export type RolePermissionGrant = typeof rolePermissionGrants.$inferSelect;
export type GroupRole = typeof groupRoles.$inferSelect;
export type AccessVersion = typeof accessVersions.$inferSelect;
export type ResourceGrant = typeof resourceGrants.$inferSelect;
export type OrgModule = typeof orgModules.$inferSelect;
