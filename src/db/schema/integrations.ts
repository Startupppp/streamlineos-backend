
import { boolean, index, serial, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "./auth";

export type IntegrationToolkit = "googlecalendar" | "outlook";
export type IntegrationConnectionStatus = "active" | "needs_reauth" | "disabled";
export type IntegrationConnectionScope = "user" | "org";

export const userIntegrationConnections = pgTable(
  "user_integration_connections",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
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
  ],
);

export const userIntegrationConnectionsRelations = relations(userIntegrationConnections, ({ one }) => ({
  user: one(users, { fields: [userIntegrationConnections.userId], references: [users.id] }),
}));
