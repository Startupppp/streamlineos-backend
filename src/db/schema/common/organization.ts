import {
  pgTable,
  text,
  timestamp,
  index,
  uniqueIndex,
  jsonb,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "./auth";

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
    status: text("status").$type<NodeStatus>().default("ACTIVE").notNull(),
    metadata: jsonb("metadata").$type<OrgUnitMetadata>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    index("idx_org_units_org_kind").on(table.orgId, table.kind),
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
    role: text("role").default("member").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_org_unit_members_unit_user").on(
      table.orgUnitId,
      table.userId,
    ),
    index("idx_org_unit_members_org_user").on(table.orgId, table.userId),
    index("idx_org_unit_members_unit").on(table.orgUnitId),
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

