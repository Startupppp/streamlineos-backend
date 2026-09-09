
import { boolean, index, integer, serial, pgTable, text, timestamp, unique, uniqueIndex, foreignKey } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { organizations, organizationMembers } from "./auth";

export type IntegrationToolkit = "googlecalendar" | "outlook" | "gmail";
export type IntegrationConnectionStatus = "active" | "needs_reauth" | "disabled";
export type IntegrationConnectionScope = "user" | "org";

export const userIntegrationConnections = pgTable(
  "user_integration_connections",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    // Retained solely for a stable account-label projection; membershipId owns access.
    userId: text("user_id").notNull(),
    membershipId: integer("membership_id"),
    toolkit: text("toolkit").$type<IntegrationToolkit>().notNull(),
    composioConnectedAccountId: text("composio_connected_account_id").notNull(),
    accountEmail: text("account_email"),
    accountLabel: text("account_label"),
    status: text("status").$type<IntegrationConnectionStatus>().default("active").notNull(),
    isPrimary: boolean("is_primary").default(false).notNull(),
    scope: text("scope").$type<IntegrationConnectionScope>().default("user").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    unique("uq_integration_connections_composio_account").on(table.composioConnectedAccountId),
    index("idx_integration_connections_org_user").on(table.orgId, table.userId),
    index("idx_integration_connections_org_membership").on(table.orgId, table.membershipId),
    unique("uniq_user_integration_connections_org_id").on(table.orgId, table.id),
    uniqueIndex("uq_integration_connections_org_scoped_toolkit")
      .on(table.orgId, table.toolkit)
      .where(sql`${table.scope} = 'org'`),
    foreignKey({
      name: "fk_user_integration_connections_actor",
      columns: [table.orgId, table.membershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    }).onDelete("cascade"),
  ],
);

export const userIntegrationConnectionsRelations = relations(userIntegrationConnections, () => ({}));
