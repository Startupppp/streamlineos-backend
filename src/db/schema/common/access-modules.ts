/**
 * Which modules apply, and to whom.
 *
 * `org_modules` is the organisation's entitlement — what `isModuleEnabled`
 * reads, and what makes `assertModuleAccessPolicy` refuse before any authority
 * check. `user_module_access` is the per-person override on top of it, and it
 * can only ever *remove* a module: a deny here never grants one, and never
 * overrides an org-level grant.
 *
 * A different question from `./access.ts`, which answers what a principal may do
 * once a module is in play at all. Split out verbatim; this file is a leaf.
 */

import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  index,
  uniqueIndex,
  uuid,
  varchar,
  boolean,
  foreignKey,
  unique,
} from "drizzle-orm/pg-core";
import { organizationMembers, organizations, users } from "./auth";
import { modulesCatalog } from "./modules";

export const userModuleAccess = pgTable(
  "user_module_access",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    /**
     * A deny-override hangs off the membership, not the login. Keyed on the
     * user id it survived the person leaving and rejoining the organisation,
     * and it could not carry the composite tenant FK the rest of the RBAC
     * tables use.
     */
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
    unique("uniq_user_module_access_org_id").on(table.orgId, table.id),
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
    foreignKey({
      name: "fk_user_module_access_module",
      columns: [table.moduleKey],
      foreignColumns: [modulesCatalog.moduleKey],
    }),
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
