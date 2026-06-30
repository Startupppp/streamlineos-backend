import { pgTable, text, serial, timestamp, boolean, integer, index, jsonb } from "drizzle-orm/pg-core";
import { organizations, users } from "../auth";

export const biometricDevices = pgTable("biometric_devices", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  ipAddress: text("ip_address").notNull(),
  port: integer("port").default(4370).notNull(),
  vendor: text("vendor").default("ZKTeco").notNull(),
  location: text("location"),
  isOnline: boolean("is_online").default(false).notNull(),
  lastSyncAt: timestamp("last_sync_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_biometric_devices_org").on(table.orgId),
]);

export const biometricLogs = pgTable("biometric_logs", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  deviceId: integer("device_id").references(() => biometricDevices.id).notNull(),
  userId: text("user_id").references(() => users.id),
  biometricUserId: text("biometric_user_id"),
  punchTime: timestamp("punch_time").notNull(),
  punchType: text("punch_type").default("IN").notNull(),
  rawData: jsonb("raw_data"),
  processed: boolean("processed").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_biometric_logs_org_device").on(table.orgId, table.deviceId),
  index("idx_biometric_logs_user_time").on(table.userId, table.punchTime),
]);
