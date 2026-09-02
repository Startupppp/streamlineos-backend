import { pgTable, text, serial, integer, timestamp, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "./auth";

export const userSessions = pgTable("user_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  userAgent: text("user_agent"),
  ipAddress: text("ip_address"),
  isRevoked: boolean("is_revoked").default(false).notNull(),
  lastActive: timestamp("last_active").defaultNow().notNull(),
  deviceId: text("device_id"),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_user_sessions_user_active").on(table.userId, table.isRevoked, table.createdAt),
  index("idx_user_sessions_user_revoked_last").on(table.userId, table.isRevoked, table.lastActive),
]);

export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull(),
  keyPrefix: text("key_prefix").notNull(),
  description: text("description"),
  scopes: text("scopes").array().default([]).notNull(),
  isRevoked: boolean("is_revoked").default(false).notNull(),
  lastUsedAt: timestamp("last_used_at"),
  expiresAt: timestamp("expires_at"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_api_keys_org_active").on(table.orgId, table.isRevoked),
  uniqueIndex("idx_api_keys_key_prefix").on(table.keyPrefix),
]);

export const mfaBackupCodes = pgTable("mfa_backup_codes", {
  id: serial("id").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  codeHash: text("code_hash").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_mfa_backup_codes_user").on(table.userId),
]);

export const magicLinkTokens = pgTable("magic_link_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_magic_link_tokens_user").on(table.userId),
  uniqueIndex("idx_magic_link_tokens_hash").on(table.tokenHash),
]);

export const emailOtpCodes = pgTable("email_otp_codes", {
  id: serial("id").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  codeHash: text("code_hash").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  attempts: integer("attempts").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_email_otp_codes_user_expires").on(table.userId, table.expiresAt),
]);

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

export const userApiTokens = pgTable("user_api_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull(),
  hashAlg: text("hash_alg").default("bcrypt").notNull(),
  prefix: text("prefix").notNull(),
  scopes: text("scopes").array().default([]).notNull(),
  expiresAt: timestamp("expires_at"),
  lastUsedAt: timestamp("last_used_at"),
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_user_api_tokens_hash").on(table.tokenHash),
  index("idx_user_api_tokens_user").on(table.userId),
  index("idx_user_api_tokens_legacy_lookup").on(table.prefix, table.hashAlg),
]);

export const userSessionsRelations = relations(userSessions, ({ one }) => ({
  user: one(users, { fields: [userSessions.userId], references: [users.id] }),
}));

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  organization: one(organizations, { fields: [apiKeys.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [apiKeys.createdBy], references: [users.id] }),
}));

export const mfaBackupCodesRelations = relations(mfaBackupCodes, ({ one }) => ({
  user: one(users, { fields: [mfaBackupCodes.userId], references: [users.id] }),
}));

export const devicesRelations = relations(devices, ({ one }) => ({
  user: one(users, { fields: [devices.userId], references: [users.id] }),
}));

export const loginHistoryRelations = relations(loginHistory, ({ one }) => ({
  user: one(users, { fields: [loginHistory.userId], references: [users.id] }),
  organization: one(organizations, { fields: [loginHistory.orgId], references: [organizations.id] }),
}));

export const userApiTokensRelations = relations(userApiTokens, ({ one }) => ({
  user: one(users, { fields: [userApiTokens.userId], references: [users.id] }),
}));

export const magicLinkTokensRelations = relations(magicLinkTokens, ({ one }) => ({
  user: one(users, { fields: [magicLinkTokens.userId], references: [users.id] }),
}));

export const emailOtpCodesRelations = relations(emailOtpCodes, ({ one }) => ({
  user: one(users, { fields: [emailOtpCodes.userId], references: [users.id] }),
}));
