import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { invitations, organizations, users } from "./auth";

export const mfaBackupCodes = pgTable(
  "mfa_backup_codes",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("idx_mfa_backup_codes_user").on(table.userId)],
);

export const magicLinkTokens = pgTable(
  "magic_link_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    orgId: text("org_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_magic_link_tokens_user").on(table.userId),
    index("idx_magic_link_tokens_org").on(table.orgId),
    uniqueIndex("idx_magic_link_tokens_hash").on(table.tokenHash),
  ],
);

export const emailOtpCodes = pgTable(
  "email_otp_codes",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    attempts: integer("attempts").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_email_otp_codes_user_expires").on(table.userId, table.expiresAt),
  ],
);

export const userApiTokens = pgTable(
  "user_api_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    hashAlg: text("hash_alg").default("bcrypt").notNull(),
    prefix: text("prefix").notNull(),
    scopes: text("scopes").array().default([]).notNull(),
    expiresAt: timestamp("expires_at"),
    lastUsedAt: timestamp("last_used_at"),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_user_api_tokens_hash").on(table.tokenHash),
    index("idx_user_api_tokens_user").on(table.userId),
    index("idx_user_api_tokens_legacy_lookup").on(table.prefix, table.hashAlg),
  ],
);

export const invitationEmailOtps = pgTable(
  "invitation_email_otps",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    invitationId: text("invitation_id")
      .references(() => invitations.id, { onDelete: "cascade" })
      .notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    attempts: integer("attempts").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_invitation_email_otps_inv_expires").on(table.invitationId, table.expiresAt),
  ],
);

export const mfaBackupCodesRelations = relations(mfaBackupCodes, ({ one }) => ({
  user: one(users, { fields: [mfaBackupCodes.userId], references: [users.id] }),
}));

export const userApiTokensRelations = relations(userApiTokens, ({ one }) => ({
  user: one(users, { fields: [userApiTokens.userId], references: [users.id] }),
}));
