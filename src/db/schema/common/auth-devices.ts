import { pgTable, text, timestamp, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "./auth";

export const devices = pgTable("devices", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  fingerprint: text("fingerprint").notNull(),
  browser: text("browser"),
  os: text("os"),
  platform: text("platform"),
  trusted: boolean("trusted").default(false).notNull(),
  lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_devices_user_fingerprint").on(table.userId, table.fingerprint),
]);

export const loginHistory = pgTable("login_history", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }),
  event: text("event").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  country: text("country"),
  city: text("city"),
  success: boolean("success").default(true).notNull(),
  failureReason: text("failure_reason"),
  deviceId: text("device_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_login_history_user_created").on(table.userId, table.createdAt),
  index("idx_login_history_org_created").on(table.orgId, table.createdAt),
  index("idx_login_history_user_success").on(table.userId, table.success),
]);

export const devicesRelations = relations(devices, ({ one }) => ({
  user: one(users, { fields: [devices.userId], references: [users.id] }),
}));

export const loginHistoryRelations = relations(loginHistory, ({ one }) => ({
  user: one(users, { fields: [loginHistory.userId], references: [users.id] }),
  organization: one(organizations, { fields: [loginHistory.orgId], references: [organizations.id] }),
}));
