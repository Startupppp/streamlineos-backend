import { pgTable, text, timestamp, integer, foreignKey, index, unique, primaryKey } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizationMembers, organizations, permissions, users } from "./auth";

export const userDelegations = pgTable("user_delegations", {
  id: text("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  delegatorMembershipId: integer("delegator_membership_id").notNull(),
  delegateeMembershipId: integer("delegatee_membership_id").notNull(),
  startsAt: timestamp("starts_at").defaultNow().notNull(),
  endsAt: timestamp("ends_at").notNull(),
  reason: text("reason"),
  status: text("status").default("ACTIVE").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  revokedAt: timestamp("revoked_at"),
  revokedBy: text("revoked_by").references(() => users.id),
}, (table) => [
  unique("uniq_user_delegations_org_id").on(table.orgId, table.id),
  index("idx_user_delegations_delegatee_status").on(
    table.orgId,
    table.delegateeMembershipId,
    table.status,
  ),
  index("idx_user_delegations_org_ends").on(table.orgId, table.endsAt),
  foreignKey({
    name: "fk_user_delegations_delegator_membership",
    columns: [table.orgId, table.delegatorMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "fk_user_delegations_delegatee_membership",
    columns: [table.orgId, table.delegateeMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
  }).onDelete("cascade"),
]);

export const userDelegationPermissions = pgTable("user_delegation_permissions", {
  orgId: text("org_id").notNull(),
  delegationId: text("delegation_id").notNull(),
  permissionKey: text("permission_key")
    .references(() => permissions.name, { onDelete: "restrict" })
    .notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  primaryKey({
    name: "pk_user_delegation_permissions",
    columns: [table.delegationId, table.permissionKey],
  }),
  foreignKey({
    name: "fk_user_delegation_permissions_org_delegation",
    columns: [table.orgId, table.delegationId],
    foreignColumns: [userDelegations.orgId, userDelegations.id],
  }).onDelete("cascade"),
  index("idx_user_delegation_permissions_org_delegation").on(
    table.orgId,
    table.delegationId,
  ),
  index("idx_user_delegation_permissions_key").on(table.permissionKey),
]);

export const userDelegationsRelations = relations(userDelegations, ({ one, many }) => ({
  org: one(organizations, { fields: [userDelegations.orgId], references: [organizations.id] }),
  delegatorMembership: one(organizationMembers, {
    fields: [userDelegations.orgId, userDelegations.delegatorMembershipId],
    references: [organizationMembers.orgId, organizationMembers.id],
    relationName: "delegatorMembership",
  }),
  delegateeMembership: one(organizationMembers, {
    fields: [userDelegations.orgId, userDelegations.delegateeMembershipId],
    references: [organizationMembers.orgId, organizationMembers.id],
    relationName: "delegateeMembership",
  }),
  permissionGrants: many(userDelegationPermissions),
}));

export const userDelegationPermissionsRelations = relations(
  userDelegationPermissions,
  ({ one }) => ({
    delegation: one(userDelegations, {
      fields: [
        userDelegationPermissions.orgId,
        userDelegationPermissions.delegationId,
      ],
      references: [userDelegations.orgId, userDelegations.id],
    }),
    permission: one(permissions, {
      fields: [userDelegationPermissions.permissionKey],
      references: [permissions.name],
    }),
  }),
);
