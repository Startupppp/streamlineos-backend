import {
  pgTable,
  text,
  integer,
  timestamp,
  uuid,
  foreignKey,
  index,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { organizations, organizationMembers } from "./auth";
import { modulesCatalog } from "./modules";

type TransferStatus = "PENDING" | "ACCEPTED" | "DECLINED" | "CANCELLED" | "EXPIRED";
type TransferScope = "ORGANIZATION" | "MODULE";

export const moduleOwnerships = pgTable(
  "module_ownerships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    moduleKey: text("module_key")
      .notNull()
      .references(() => modulesCatalog.moduleKey),
    ownerMembershipId: integer("owner_membership_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("uniq_module_ownerships_org_module").on(table.orgId, table.moduleKey),
    foreignKey({
      name: "fk_module_ownerships_member",
      columns: [table.orgId, table.ownerMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    }).onDelete("restrict"),
  ],
);

export const ownershipTransfers = pgTable(
  "ownership_transfers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scope: text("scope").$type<TransferScope>().notNull(),
    moduleKey: text("module_key").references(() => modulesCatalog.moduleKey),
    fromMembershipId: integer("from_membership_id").notNull(),
    initiatedByMembershipId: integer("initiated_by_membership_id").notNull(),
    toMembershipId: integer("to_membership_id").notNull(),
    status: text("status").$type<TransferStatus>().default("PENDING").notNull(),
    initiatedAt: timestamp("initiated_at", { withTimezone: true }).defaultNow().notNull(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    reason: text("reason"),
  },
  (table) => [
    index("idx_ownership_transfers_org_status").on(table.orgId, table.status),
    index("idx_ownership_transfers_to_pending").on(table.orgId, table.toMembershipId),
    index("idx_ownership_transfers_expires").on(table.expiresAt),
    uniqueIndex("uniq_ownership_xfers_org_pending_org")
      .on(table.orgId)
      .where(sql`status = 'PENDING' AND scope = 'ORGANIZATION'`),
    uniqueIndex("uniq_ownership_xfers_org_pending_module")
      .on(table.orgId, table.moduleKey)
      .where(sql`status = 'PENDING' AND scope = 'MODULE'`),
    foreignKey({
      name: "fk_ownership_transfers_from_member",
      columns: [table.orgId, table.fromMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_ownership_transfers_to_member",
      columns: [table.orgId, table.toMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_ownership_transfers_initiator",
      columns: [table.orgId, table.initiatedByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    }).onDelete("restrict"),
  ],
);

export const moduleOwnershipsRelations = relations(moduleOwnerships, ({ one }) => ({
  organization: one(organizations, {
    fields: [moduleOwnerships.orgId],
    references: [organizations.id],
  }),
  ownerMembership: one(organizationMembers, {
    fields: [moduleOwnerships.orgId, moduleOwnerships.ownerMembershipId],
    references: [organizationMembers.orgId, organizationMembers.id],
  }),
}));

export const ownershipTransfersRelations = relations(ownershipTransfers, ({ one }) => ({
  organization: one(organizations, {
    fields: [ownershipTransfers.orgId],
    references: [organizations.id],
  }),
  fromMembership: one(organizationMembers, {
    fields: [ownershipTransfers.orgId, ownershipTransfers.fromMembershipId],
    references: [organizationMembers.orgId, organizationMembers.id],
    relationName: "fromOwnershipTransfer",
  }),
  toMembership: one(organizationMembers, {
    fields: [ownershipTransfers.orgId, ownershipTransfers.toMembershipId],
    references: [organizationMembers.orgId, organizationMembers.id],
    relationName: "toOwnershipTransfer",
  }),
  initiatedByMembership: one(organizationMembers, {
    fields: [ownershipTransfers.orgId, ownershipTransfers.initiatedByMembershipId],
    references: [organizationMembers.orgId, organizationMembers.id],
    relationName: "initiatedOwnershipTransfer",
  }),
}));
