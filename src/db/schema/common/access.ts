import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  index,
  uniqueIndex,
  pgEnum,
  uuid,
  varchar,
  boolean,
  foreignKey,
  unique,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import {
  organizationMembers,
  organizations,
  users,
  roles,
  permissions,
} from "./auth";
import { orgUnits } from "./organization";
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
      .references(() => roles.id, { onDelete: "cascade" })
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
    index("idx_role_assignments_org_membership").on(
      table.orgId,
      table.organizationMembershipId,
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
    }),
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
      .references(() => roles.id, { onDelete: "cascade" })
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
    index("idx_role_permission_grants_org_role").on(table.orgId, table.roleId),
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
      .references(() => permissions.name, { onDelete: "cascade" })
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
    index("idx_user_permission_grants_org_membership").on(
      table.orgId,
      table.organizationMembershipId,
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
    }),
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

export const userModuleAccess = pgTable(
  "user_module_access",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
<<<<<<< HEAD
    /**
     * A deny-override hangs off the membership, not the login. Keyed on the
     * user id it survived the person leaving and rejoining the organisation,
     * and it could not carry the composite tenant FK the rest of the RBAC
     * tables use.
     */
=======
>>>>>>> origin/main
    organizationMembershipId: integer("organization_membership_id").notNull(),
    moduleKey: text("module_key").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    updatedBy: text("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
<<<<<<< HEAD
    unique("uniq_user_module_access_org_id").on(table.orgId, table.id),
=======
>>>>>>> origin/main
    uniqueIndex("uniq_user_module_access_org_membership_module").on(
      table.orgId,
      table.organizationMembershipId,
      table.moduleKey,
    ),
    index("idx_user_module_access_org_membership").on(
      table.orgId,
      table.organizationMembershipId,
    ),
    foreignKey({
      name: "fk_user_module_access_membership",
      columns: [table.orgId, table.organizationMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    }).onDelete("cascade"),
<<<<<<< HEAD
=======
    foreignKey({
      name: "fk_user_module_access_module",
      columns: [table.moduleKey],
      foreignColumns: [modulesCatalog.moduleKey],
    }),
>>>>>>> origin/main
  ],
);

export const orgModules = pgTable(
  "org_modules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    moduleKey: text("module_key")
      .notNull()
      .references(() => modulesCatalog.moduleKey),
    enabled: boolean("enabled").default(true).notNull(),
    enabledAt: timestamp("enabled_at").defaultNow().notNull(),
    enabledBy: varchar("enabled_by", { length: 36 }),
  },
  (t) => [
    uniqueIndex("org_modules_unique_idx").on(t.orgId, t.moduleKey),
    index("org_modules_org_idx").on(t.orgId),
  ],
);

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
