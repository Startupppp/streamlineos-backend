import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  unique,
  uniqueIndex,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { managedProductStatusEnum } from "../common/enums";
import { organizations, users, organizationMembers } from "../common/auth";
import { pmWorkspaces } from "./pm-workspaces";

export const managedProducts = pgTable(
  "managed_products",
  {
    managedProductId: serial("managed_product_id").primaryKey(),
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
    pmWorkspaceId: text("pm_workspace_id").references(() => pmWorkspaces.pmWorkspaceId, { onDelete: "set null" }),
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
    unique("uniq_managed_products_org_pk").on(table.orgId, table.managedProductId),
    foreignKey({
      columns: [table.orgId, table.ownerMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    }).onDelete("set null"),
  ],
);
