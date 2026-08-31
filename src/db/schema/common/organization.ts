import {
  pgTable,
  text,
  timestamp,
  integer,
  index,
  unique,
  uniqueIndex,
  foreignKey,
  check,
  jsonb,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { organizationMembers, organizations, users } from "./auth";

type NodeStatus = "ACTIVE" | "DISABLED" | "ARCHIVED";

export type OrgUnitKind =
  | "BUSINESS_UNIT"
  | "BRANCH"
  | "DEPARTMENT"
  | "TEAM"
  | "LOCATION"
  | "COST_CENTER";

export type OrgUnitMetadata = {
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  phone?: string;
  email?: string;
  locationType?: "OFFICE" | "WAREHOUSE" | "STORE" | "FACTORY" | "REMOTE";
  latitude?: number;
  longitude?: number;
  capacity?: number;
  hrContactUserId?: string;
};

export const orgUnits = pgTable(
  "org_units",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    kind: text("kind").$type<OrgUnitKind>().notNull(),
    parentId: text("parent_id").references((): AnyPgColumn => orgUnits.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    code: text("code").notNull(),
    description: text("description"),
    headUserId: text("head_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    headMembershipId: integer("head_membership_id"),
    status: text("status").$type<NodeStatus>().default("ACTIVE").notNull(),
    metadata: jsonb("metadata").$type<OrgUnitMetadata>(),
    rowVersion: integer("row_version").default(1).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedByMembershipId: integer("archived_by_membership_id"),
    updatedByMembershipId: integer("updated_by_membership_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    unique("uniq_org_units_org_id").on(table.orgId, table.id),
    foreignKey({
      name: "fk_org_units_parent_tenant",
      columns: [table.orgId, table.parentId],
      foreignColumns: [table.orgId, table.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_org_units_head_membership",
      columns: [table.orgId, table.headMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    }).onDelete("set null"),
    foreignKey({
      name: "fk_org_units_archived_by_membership",
      columns: [table.orgId, table.archivedByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_org_units_updated_by_membership",
      columns: [table.orgId, table.updatedByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    }).onDelete("restrict"),
    check("chk_org_units_row_version_positive", sql`${table.rowVersion} > 0`),
    check(
      "chk_org_units_kind",
      sql`${table.kind} IN ('BUSINESS_UNIT', 'BRANCH', 'DEPARTMENT', 'TEAM', 'LOCATION', 'COST_CENTER')`,
    ),
    check(
      "chk_org_units_status",
      sql`${table.status} IN ('ACTIVE', 'DISABLED', 'ARCHIVED')`,
    ),
    check(
      "chk_org_units_parent_not_self",
      sql`${table.parentId} IS NULL OR ${table.parentId} <> ${table.id}`,
    ),
    index("idx_org_units_org_kind").on(table.orgId, table.kind),
    index("idx_org_units_head_membership").on(table.orgId, table.headMembershipId),
    index("idx_org_units_parent").on(table.parentId),
    uniqueIndex("uniq_org_units_org_kind_code").on(
      table.orgId,
      table.kind,
      table.code,
    ),
  ],
);

export const orgUnitMembers = pgTable(
  "org_unit_members",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    orgUnitId: text("org_unit_id")
      .references(() => orgUnits.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    membershipId: integer("membership_id"),
    role: text("role").default("member").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_org_unit_members_unit_user").on(
      table.orgUnitId,
      table.userId,
    ),
    index("idx_org_unit_members_org_user").on(table.orgId, table.userId),
    index("idx_org_unit_members_membership").on(table.orgId, table.membershipId),
    index("idx_org_unit_members_unit").on(table.orgUnitId),
    foreignKey({
      name: "fk_org_unit_members_membership",
      columns: [table.orgId, table.membershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    }).onDelete("set null"),
  ],
);

export const orgUnitsRelations = relations(orgUnits, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [orgUnits.orgId],
    references: [organizations.id],
  }),
  parent: one(orgUnits, {
    fields: [orgUnits.parentId],
    references: [orgUnits.id],
    relationName: "childUnits",
  }),
  children: many(orgUnits, { relationName: "childUnits" }),
  head: one(users, {
    fields: [orgUnits.headUserId],
    references: [users.id],
  }),
  members: many(orgUnitMembers),
}));

export const orgUnitMembersRelations = relations(orgUnitMembers, ({ one }) => ({
  orgUnit: one(orgUnits, {
    fields: [orgUnitMembers.orgUnitId],
    references: [orgUnits.id],
  }),
  user: one(users, {
    fields: [orgUnitMembers.userId],
    references: [users.id],
  }),
  organization: one(organizations, {
    fields: [orgUnitMembers.orgId],
    references: [organizations.id],
  }),
}));

