import { pgTable, text, serial, timestamp, boolean, jsonb, decimal, date, integer, foreignKey, index, uniqueIndex, unique, primaryKey, uuid } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { genderEnum, onboardingStatusEnum, onboardingDocStatusEnum, membershipStatusEnum, organizationStatusEnum, invitationStatusEnum } from "./enums";
import { modulesCatalog } from "./modules";


export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  website: text("website"),
  industry: text("industry"),
  /**
   * Where this organisation's data physically lives. Nullable because an
   * unplaced organisation must be representable — resolution then fails closed
   * rather than guessing a region and writing rows into the wrong database.
   */
  region: text("region"),
  timezone: text("timezone").default("Asia/Kolkata").notNull(),
  currency: text("currency").default("INR").notNull(),
  fiscalYearStart: integer("fiscal_year_start").default(4).notNull(),
  settings: jsonb("settings").$type<Record<string, unknown>>(),
  billingEmail: text("billing_email"),
  address: jsonb("address").$type<{ line1?: string; line2?: string; city?: string; state?: string; country?: string; postalCode?: string }>(),
  mfaEnforced: boolean("mfa_enforced").default(false).notNull(),
  maxConcurrentSessions: integer("max_concurrent_sessions"),
  ownerMembershipId: integer("owner_membership_id").notNull(),
  onboardingCompletedAt: timestamp("onboarding_completed_at"),
  status: text("status").default("ACTIVE").notNull(),
  statusV2: organizationStatusEnum("status_v2"),
  purgeScheduledAt: timestamp("purge_scheduled_at", { withTimezone: true }),
  purgeScheduledBy: text("purge_scheduled_by"),
  purgeJobId: text("purge_job_id"),
  purgedAt: timestamp("purged_at", { withTimezone: true }),
  purgeReason: text("purge_reason"),
  deletedAt: timestamp("deleted_at"),
  companySize: text("company_size"),
  country: text("country"),
  legalName: text("legal_name"),
  orgCode: text("org_code"),
  registrationNumber: text("registration_number"),
  taxNumber: text("tax_number"),
  supportEmail: text("support_email"),
  supportPhone: text("support_phone"),
  favicon: text("favicon"),
  secondaryColor: text("secondary_color"),
  businessHours: jsonb("business_hours").$type<Record<string, { open: string; close: string; enabled: boolean }>>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export const orgCustomDomains = pgTable("org_custom_domains", {
  id: text("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  domain: text("domain").notNull(),
  verificationToken: text("verification_token").notNull(),
  verifiedAt: timestamp("verified_at"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_org_custom_domains_domain").on(table.domain),
  unique("uniq_org_custom_domains_org_id").on(table.orgId, table.id),
]);

export const orgHolidays = pgTable("org_holidays", {
  id: text("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  date: date("date").notNull(),
  recurring: boolean("recurring").default(false).notNull(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_org_holidays_org_date").on(table.orgId, table.date),
]);

export const organizationAllowedEmailDomains = pgTable("organization_allowed_email_domains", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  domain: text("domain").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_org_allowed_domains_org_domain").on(table.orgId, table.domain),
]);

export const organizationMembers = pgTable("organization_members", {
  id: serial("id").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  role: text("role").default("MEMBER").notNull(),
  isOwner: boolean("is_owner").default(false).notNull(),
  status: membershipStatusEnum("status").default("ACTIVE").notNull(),
  invitedAt: timestamp("invited_at"),
  activatedAt: timestamp("activated_at"),
  suspendedAt: timestamp("suspended_at"),
  leftAt: timestamp("left_at"),
  joinedAt: timestamp("joined_at").defaultNow().notNull(),
  onboardingCompletedAt: timestamp("onboarding_completed_at"),
}, (table) => [
  uniqueIndex("uniq_org_members_user_org").on(table.userId, table.orgId),
  unique("uniq_org_members_org_user").on(table.orgId, table.userId),
  unique("uniq_org_members_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_org_members_single_owner").on(table.orgId).where(sql`is_owner = true`),
  index("idx_org_members_org_role").on(table.orgId, table.role),
  index("idx_org_members_owner").on(table.orgId, table.isOwner),
  index("idx_org_members_org_status").on(table.orgId, table.status),
  index("idx_org_members_org_joined").on(table.orgId, table.joinedAt.desc()),
]);

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name"),
  email: text("email").notNull().unique(),
  emailVerified: timestamp("email_verified"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  gender: genderEnum("gender"),
  dateOfBirth: date("date_of_birth"),
  image: text("image"),
  phone: text("phone"),
  whatsappNumber: text("whatsapp_number"),
  whatsappSameAsPhone: boolean("whatsapp_same_as_phone").default(true).notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  isActive: boolean("is_active").default(true).notNull(),
  userStatus: text("user_status").default("active").notNull(),
  invitedAt: timestamp("invited_at"),
  activatedAt: timestamp("activated_at"),
  archivedAt: timestamp("archived_at"),
  deletedAt: timestamp("deleted_at"),
  emergencyContact: jsonb("emergency_contact").$type<{
    name: string;
    relation: string;
    phone: string;
    email?: string;
  }>(),
  totpSecret: text("totp_secret"),
  totpEnabled: boolean("totp_enabled").default(false).notNull(),
  isProfilePictureRequired: boolean("is_profile_picture_required").default(false).notNull(),
  bio: text("bio"),
  linkedinUrl: text("linkedin_url"),
  twitterUrl: text("twitter_url"),
  githubUrl: text("github_url"),
  websiteUrl: text("website_url"),
  onboardingDocStatus: onboardingDocStatusEnum("onboarding_doc_status").default("PENDING").notNull(),
  onboardingCompletedAt: timestamp("onboarding_completed_at"),
  lastActiveOrgId: text("last_active_org_id").references(() => organizations.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_users_last_active_org").on(table.lastActiveOrgId),
]);

export const accounts = pgTable("accounts", {
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  type: text("type").notNull(),
  provider: text("provider").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  refresh_token: text("refresh_token"),
  access_token: text("access_token"),
  expires_at: integer("expires_at"),
  token_type: text("token_type"),
  scope: text("scope"),
  id_token: text("id_token"),
  session_state: text("session_state"),
}, (table) => [
  primaryKey({ columns: [table.provider, table.providerAccountId] }),
]);

export const verificationTokens = pgTable("verification_tokens", {
  identifier: text("identifier").notNull(),
  token: text("token").notNull(),
  expires: timestamp("expires").notNull(),
}, (table) => [
  primaryKey({ columns: [table.identifier, table.token] }),
  index("idx_verification_tokens_expires").on(table.expires),
]);

export const invitations = pgTable("invitations", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  role: text("role").default("MEMBER").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  acceptedAt: timestamp("accepted_at"),
  status: invitationStatusEnum("status").default("PENDING").notNull(),
  inviterMembershipId: integer("inviter_membership_id"),
  acceptedMembershipId: integer("accepted_membership_id"),
  declinedAt: timestamp("declined_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedByMembershipId: integer("revoked_by_membership_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_invitations_org_email").on(table.orgId, table.email),
  index("idx_invitations_org_inviter_membership").on(table.orgId, table.inviterMembershipId),
  index("idx_invitations_org_accepted_membership").on(table.orgId, table.acceptedMembershipId),
  index("idx_invitations_org_revoked_by_membership").on(table.orgId, table.revokedByMembershipId),
  index("idx_invitations_expires").on(table.expiresAt),
  index("idx_invitations_status").on(table.orgId, table.status),
  uniqueIndex("uniq_invitations_org_email_pending").on(table.orgId, table.email).where(sql`accepted_at IS NULL`),
  foreignKey({ columns: [table.orgId, table.inviterMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_invitations_org_inviter_membership" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.acceptedMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_invitations_org_accepted_membership" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.revokedByMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_invitations_org_revoked_by_membership" }).onDelete("set null"),
]);

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

export const roles = pgTable("roles", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  isSystem: boolean("is_system").default(false).notNull(),
  moduleKey: text("module_key").references(() => modulesCatalog.moduleKey),
  rank: integer("rank").notNull().default(40),
  description: text("description"),
  version: integer("version").notNull().default(1),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_role_slug_org").on(table.slug, table.orgId),
  unique("uniq_roles_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_roles_org_module_name_ci").on(
    table.orgId,
    sql`COALESCE(${table.moduleKey}, '')`,
    sql`LOWER(${table.name})`,
  ),
]);

export const permissions = pgTable("permissions", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  resource: text("resource").notNull(),
  action: text("action").notNull(),
  description: text("description"),
  moduleKey: text("module_key"),
  administeringModuleKey: text("administering_module_key").references(
    () => modulesCatalog.moduleKey,
  ),
  riskClass: text("risk_class"),
  isDelegable: boolean("is_delegable").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_permissions_name_administering_module").on(
    table.name,
    table.administeringModuleKey,
  ),
]);

export const onboardingSteps = pgTable("onboarding_steps", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  stepName: text("step_name").notNull(),
  status: onboardingStatusEnum("status").default("PENDING").notNull(),
  completedAt: timestamp("completed_at"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_onboarding_steps_user").on(table.userId),
  index("idx_onboarding_steps_org_status").on(table.orgId, table.status),
]);

export const organizationsRelations = relations(organizations, ({ many }) => ({
  members: many(organizationMembers),
}));

export const organizationMembersRelations = relations(organizationMembers, ({ one }) => ({
  user: one(users, {
    fields: [organizationMembers.userId],
    references: [users.id],
  }),
  organization: one(organizations, {
    fields: [organizationMembers.orgId],
    references: [organizations.id],
  }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  organizations: many(organizationMembers),
  accounts: many(accounts),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, {
    fields: [accounts.userId],
    references: [users.id],
  }),
}));


export const rolesRelations = relations(roles, ({ one }) => ({
  organization: one(organizations, {
    fields: [roles.orgId],
    references: [organizations.id],
  }),
}));

export const onboardingStepsRelations = relations(onboardingSteps, ({ one }) => ({
  user: one(users, {
    fields: [onboardingSteps.userId],
    references: [users.id],
  }),
  organization: one(organizations, {
    fields: [onboardingSteps.orgId],
    references: [organizations.id],
  }),
}));

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

export const userApiTokensRelations = relations(userApiTokens, ({ one }) => ({
  user: one(users, { fields: [userApiTokens.userId], references: [users.id] }),
}));

export const userDelegations = pgTable("user_delegations", {
  id: text("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  delegatorMembershipId: integer("delegator_membership_id").notNull(),
  delegateeMembershipId: integer("delegatee_membership_id").notNull(),
  startsAt: timestamp("starts_at").defaultNow().notNull(),
  endsAt: timestamp("ends_at").notNull(),
  reason: text("reason"),
  status: text("status").default("ACTIVE").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  revokedAt: timestamp("revoked_at"),
  revokedBy: text("revoked_by").references(() => users.id),
}, (table) => [
  unique("uniq_user_delegations_org_id").on(table.orgId, table.id),
  index("idx_user_delegations_delegatee_status").on(
    table.orgId,
    table.delegateeMembershipId,
    table.status,
  ),
  index("idx_user_delegations_org_ends").on(table.orgId, table.endsAt),
  foreignKey({
    name: "fk_user_delegations_delegator_membership",
    columns: [table.orgId, table.delegatorMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "fk_user_delegations_delegatee_membership",
    columns: [table.orgId, table.delegateeMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
  }).onDelete("cascade"),
]);

export const userDelegationPermissions = pgTable("user_delegation_permissions", {
  orgId: text("org_id").notNull(),
  delegationId: text("delegation_id").notNull(),
  permissionKey: text("permission_key")
    .references(() => permissions.name, { onDelete: "restrict" })
    .notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  primaryKey({
    name: "pk_user_delegation_permissions",
    columns: [table.delegationId, table.permissionKey],
  }),
  foreignKey({
    name: "fk_user_delegation_permissions_org_delegation",
    columns: [table.orgId, table.delegationId],
    foreignColumns: [userDelegations.orgId, userDelegations.id],
  }).onDelete("cascade"),
  index("idx_user_delegation_permissions_org_delegation").on(
    table.orgId,
    table.delegationId,
  ),
  index("idx_user_delegation_permissions_key").on(table.permissionKey),
]);

export const userDelegationsRelations = relations(userDelegations, ({ one, many }) => ({
  org: one(organizations, { fields: [userDelegations.orgId], references: [organizations.id] }),
  delegatorMembership: one(organizationMembers, {
    fields: [userDelegations.orgId, userDelegations.delegatorMembershipId],
    references: [organizationMembers.orgId, organizationMembers.id],
    relationName: "delegatorMembership",
  }),
  delegateeMembership: one(organizationMembers, {
    fields: [userDelegations.orgId, userDelegations.delegateeMembershipId],
    references: [organizationMembers.orgId, organizationMembers.id],
    relationName: "delegateeMembership",
  }),
  permissionGrants: many(userDelegationPermissions),
}));

export const userDelegationPermissionsRelations = relations(
  userDelegationPermissions,
  ({ one }) => ({
    delegation: one(userDelegations, {
      fields: [
        userDelegationPermissions.orgId,
        userDelegationPermissions.delegationId,
      ],
      references: [userDelegations.orgId, userDelegations.id],
    }),
    permission: one(permissions, {
      fields: [userDelegationPermissions.permissionKey],
      references: [permissions.name],
    }),
  }),
);
