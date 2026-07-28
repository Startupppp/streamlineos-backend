import { pgTable, text, primaryKey } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { permissions } from "./auth";
import { dataScopeEnum } from "./access";

export const permissionSupportedScopes = pgTable(
  "permission_supported_scopes",
  {
    permissionKey: text("permission_key")
      .references(() => permissions.name, { onDelete: "cascade" })
      .notNull(),
    scope: dataScopeEnum("scope").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.permissionKey, table.scope] }),
  ],
);

export const permissionSupportedScopesRelations = relations(
  permissionSupportedScopes,
  ({ one }) => ({
    permission: one(permissions, {
      fields: [permissionSupportedScopes.permissionKey],
      references: [permissions.name],
    }),
  }),
);

export type PermissionSupportedScope = typeof permissionSupportedScopes.$inferSelect;
