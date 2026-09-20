import {
  text,
  timestamp,
  integer,
  jsonb,
  date,
  index,
  unique,
  uniqueIndex,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import { build } from "./namespaces";
import { relations, sql } from "drizzle-orm";
import { managedProductStatusEnum } from "../common/enums";
import { organizations, users, organizationMembers } from "../common/auth";
import { pmWorkspaces } from "./pm-workspaces";

export const managedProducts = build.table(
  "managed_products",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    key: text("key").notNull(),
    description: text("description"),
    status: managedProductStatusEnum("status").default("active").notNull(),
    ownerId: text("owner_id").references(() => users.id, {
      onDelete: "set null",
    }),
    pmWorkspaceId: text("pm_workspace_id").notNull(),
    vision: text("vision"),
    missionStatement: text("mission_statement"),
    targetCustomer: text("target_customer"),
    differentiators: text("differentiators"),
    currentPhase: text("current_phase"),
    targetLaunchDate: timestamp("target_launch_date", { withTimezone: true }),
    successMetrics: jsonb("success_metrics").$type<
      Array<{ label: string; target?: string }>
    >(),
    ownerMembershipId: integer("owner_membership_id"),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_managed_products_org_key").on(table.orgId, table.key),
    index("idx_managed_products_org_status").on(table.orgId, table.status).where(sql`deleted_at IS NULL`),
    index("idx_managed_products_org_workspace")
      .on(table.orgId, table.pmWorkspaceId)
      .where(sql`deleted_at IS NULL`),
    unique("uniq_managed_products_org_pk").on(table.orgId, table.id),
    foreignKey({
      columns: [table.orgId, table.ownerMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    }).onDelete("set null"),
    foreignKey({
      columns: [table.orgId, table.pmWorkspaceId],
      foreignColumns: [pmWorkspaces.orgId, pmWorkspaces.pmWorkspaceId],
      name: "fk_managed_products_org_pm_workspace",
    }),
  ],
);

export const managedProductReleases = build.table(
  "managed_product_releases",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    managedProductId: integer("managed_product_id")
      .notNull(),
    name: text("name").notNull(),
    version: text("version").notNull(),
    description: text("description"),
    status: text("status").default("draft").notNull(),
    releaseDate: date("release_date"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.managedProductId], foreignColumns: [managedProducts.orgId, managedProducts.id], name: "fk_managed_product_releases_org_product" }).onDelete("cascade"),
    index("idx_managed_product_releases_product").on(table.managedProductId),
    index("idx_managed_product_releases_org_status").on(table.orgId, table.status),
    unique("uniq_managed_product_releases_org_id").on(table.orgId, table.id),
    check(
      "chk_managed_product_releases_status",
      sql`${table.status} IN ('draft', 'released', 'archived')`,
    ),
  ],
);

export const managedProductsRelations = relations(managedProducts, ({ many }) => ({
  releases: many(managedProductReleases),
}));

export const managedProductReleasesRelations = relations(managedProductReleases, ({ one }) => ({
  product: one(managedProducts, {
    fields: [managedProductReleases.managedProductId],
    references: [managedProducts.id],
  }),
  createdBy: one(users, {
    fields: [managedProductReleases.createdBy],
    references: [users.id],
  }),
}));
