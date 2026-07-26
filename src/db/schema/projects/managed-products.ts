import {
  pgTable,
  serial,
  text,
  timestamp,
  index,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { managedProductStatusEnum } from "../enums";
import { organizations, users } from "../auth";
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
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_managed_products_org_key").on(table.orgId, table.key),
    index("idx_managed_products_org_status").on(table.orgId, table.status),
    unique("uniq_managed_products_org_pk").on(table.orgId, table.managedProductId),
  ],
);
