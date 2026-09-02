import { boolean, foreignKey, index, integer, jsonb, numeric, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import {
  paymentEnvironmentEnum,
  paymentProviderStatusEnum,
  paymentWebhookEndpointStatusEnum,
  paymentWebhookProcessingStatusEnum,
  paymentTestTransactionStatusEnum,
  paymentManualMethodStatusEnum,
} from "../common/enums";
import { organizations, users } from "../common/auth";

// Tenant-facing payment provider setup: lets an org connect ITS OWN Razorpay/Stripe account to
// charge ITS OWN customers (invoices, checkout, subscriptions they sell). Deliberately separate
// from subscriptions/subscriptionPayments and platformSubscriptions/platformPayments (shared.ts /
// platform.ts), which are StreamlineOS billing the tenant for their own SaaS plan — a different
// concern with different credentials. See 12_Payment_Integration_Setup_Page.md.

export const paymentProviders = pgTable("payment_providers", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  providerKey: text("provider_key").notNull(),
  displayName: text("display_name").notNull(),
  status: paymentProviderStatusEnum("status").notNull().default("not_configured"),
  environment: paymentEnvironmentEnum("environment").notNull().default("test"),
  isPrimary: boolean("is_primary").notNull().default(false),
  supportedCurrencies: jsonb("supported_currencies").$type<string[]>().notNull().default([]),
  supportedPaymentMethods: jsonb("supported_payment_methods").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uq_payment_providers_org_provider_key").on(table.orgId, table.providerKey),
  index("idx_payment_providers_org").on(table.orgId),
  unique("uniq_payment_providers_org_id").on(table.orgId, table.id),
]);

export const paymentProviderAccounts = pgTable("payment_provider_accounts", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  providerId: integer("provider_id").notNull(),
  providerAccountId: text("provider_account_id"),
  businessType: text("business_type"),
  country: text("country"),
  defaultCurrency: text("default_currency"),
  kycStatus: text("kyc_status"),
  requirementsDue: jsonb("requirements_due").$type<string[]>().notNull().default([]),
  capabilities: jsonb("capabilities").$type<Record<string, unknown>>().notNull().default({}),
  payoutStatus: text("payout_status"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.providerId], foreignColumns: [paymentProviders.orgId, paymentProviders.id], name: "fk_payment_provider_accounts_provider_id_org" }).onDelete("cascade"),
  unique("uq_payment_provider_accounts_provider").on(table.providerId),
  unique("uniq_payment_provider_accounts_org_id").on(table.orgId, table.id),
]);

// Never stores raw secrets — secretRef/webhookSecretRef point at an encrypted-at-rest value
// (see PaymentCredentialCryptoService, reusing the AES-256-GCM helper pattern from
// hr-payroll/lib/encryption.ts and onboarding/crypto.helpers.ts).
export const paymentProviderCredentials = pgTable("payment_provider_credentials", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  providerId: integer("provider_id").notNull(),
  environment: paymentEnvironmentEnum("environment").notNull(),
  keyId: text("key_id"),
  secretRef: text("secret_ref"),
  webhookSecretRef: text("webhook_secret_ref"),
  maskedKeyHint: text("masked_key_hint"),
  lastRotatedAt: timestamp("last_rotated_at"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.providerId], foreignColumns: [paymentProviders.orgId, paymentProviders.id], name: "fk_payment_provider_credentials_provider_id_org" }).onDelete("cascade"),
  unique("uq_payment_provider_credentials_provider_env").on(table.providerId, table.environment),
  unique("uniq_payment_provider_creds_org_id").on(table.orgId, table.id),
]);

export const paymentWebhookEndpoints = pgTable("payment_webhook_endpoints", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  providerId: integer("provider_id").notNull(),
  environment: paymentEnvironmentEnum("environment").notNull(),
  url: text("url").notNull(),
  expectedEvents: jsonb("expected_events").$type<string[]>().notNull().default([]),
  status: paymentWebhookEndpointStatusEnum("status").notNull().default("not_verified"),
  lastVerifiedAt: timestamp("last_verified_at"),
  lastFailureAt: timestamp("last_failure_at"),
  failureReason: text("failure_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.providerId], foreignColumns: [paymentProviders.orgId, paymentProviders.id], name: "fk_payment_webhook_endpoints_provider_id_org" }).onDelete("cascade"),
  unique("uq_payment_webhook_endpoints_provider_env").on(table.providerId, table.environment),
  unique("uniq_payment_webhook_endpoints_org_id").on(table.orgId, table.id),
]);

export const paymentWebhookEvents = pgTable("payment_webhook_events", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  providerId: integer("provider_id").notNull(),
  environment: paymentEnvironmentEnum("environment").notNull(),
  providerEventId: text("provider_event_id").notNull(),
  eventType: text("event_type").notNull(),
  signatureValid: boolean("signature_valid").notNull(),
  processingStatus: paymentWebhookProcessingStatusEnum("processing_status").notNull().default("received"),
  idempotencyKey: text("idempotency_key").notNull(),
  relatedInvoiceId: integer("related_invoice_id"),
  relatedSubscriptionId: text("related_subscription_id"),
  payloadRedacted: jsonb("payload_redacted").$type<Record<string, unknown>>().notNull().default({}),
  receivedAt: timestamp("received_at").defaultNow().notNull(),
  processedAt: timestamp("processed_at"),
  errorMessage: text("error_message"),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.providerId], foreignColumns: [paymentProviders.orgId, paymentProviders.id], name: "fk_payment_webhook_events_provider_id_org" }).onDelete("cascade"),
  unique("uq_payment_webhook_events_provider_env_event").on(table.providerId, table.environment, table.providerEventId),
  index("idx_payment_webhook_events_org").on(table.orgId, table.receivedAt),
  unique("uniq_payment_webhook_events_org_id").on(table.orgId, table.id),
]);

export const paymentTestTransactions = pgTable("payment_test_transactions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  providerId: integer("provider_id").notNull(),
  environment: paymentEnvironmentEnum("environment").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  currency: text("currency").notNull(),
  status: paymentTestTransactionStatusEnum("status").notNull().default("created"),
  providerOrderId: text("provider_order_id"),
  providerPaymentId: text("provider_payment_id"),
  signatureVerified: boolean("signature_verified").notNull().default(false),
  webhookReceived: boolean("webhook_received").notNull().default(false),
  resultSummary: text("result_summary"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.providerId], foreignColumns: [paymentProviders.orgId, paymentProviders.id], name: "fk_payment_test_transactions_provider_id_org" }).onDelete("cascade"),
  index("idx_payment_test_transactions_org").on(table.orgId, table.providerId),
  unique("uniq_payment_test_transactions_org_id").on(table.orgId, table.id),
]);

export const paymentAuditEvents = pgTable("payment_audit_events", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  providerId: integer("provider_id"),
  action: text("action").notNull(),
  environment: paymentEnvironmentEnum("environment"),
  beforeRedacted: jsonb("before_redacted").$type<Record<string, unknown>>(),
  afterRedacted: jsonb("after_redacted").$type<Record<string, unknown>>(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.providerId], foreignColumns: [paymentProviders.orgId, paymentProviders.id], name: "fk_payment_audit_events_provider_id_org" }).onDelete("cascade"),
  index("idx_payment_audit_events_org").on(table.orgId, table.createdAt),
  unique("uniq_payment_audit_events_org_id").on(table.orgId, table.id),
]);

export const paymentManualMethods = pgTable("payment_manual_methods", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  methodType: text("method_type").notNull(),
  displayName: text("display_name").notNull(),
  instructions: text("instructions"),
  bankName: text("bank_name"),
  accountHolder: text("account_holder"),
  maskedAccountNumber: text("masked_account_number"),
  ifscSwiftIban: text("ifsc_swift_iban"),
  upiId: text("upi_id"),
  paymentReferenceInstructions: text("payment_reference_instructions"),
  requireManualApproval: boolean("require_manual_approval").notNull().default(true),
  status: paymentManualMethodStatusEnum("status").notNull().default("missing_instructions"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uq_payment_manual_methods_org_type").on(table.orgId, table.methodType),
  unique("uniq_payment_manual_methods_org_id").on(table.orgId, table.id),
]);

export const paymentProvidersRelations = relations(paymentProviders, ({ one, many }) => ({
  organization: one(organizations, { fields: [paymentProviders.orgId], references: [organizations.id] }),
  account: one(paymentProviderAccounts, { fields: [paymentProviders.id], references: [paymentProviderAccounts.providerId] }),
  credentials: many(paymentProviderCredentials),
  webhookEndpoints: many(paymentWebhookEndpoints),
  testTransactions: many(paymentTestTransactions),
}));

export const paymentProviderAccountsRelations = relations(paymentProviderAccounts, ({ one }) => ({
  organization: one(organizations, { fields: [paymentProviderAccounts.orgId], references: [organizations.id] }),
  provider: one(paymentProviders, { fields: [paymentProviderAccounts.providerId], references: [paymentProviders.id] }),
}));

export const paymentProviderCredentialsRelations = relations(paymentProviderCredentials, ({ one }) => ({
  organization: one(organizations, { fields: [paymentProviderCredentials.orgId], references: [organizations.id] }),
  provider: one(paymentProviders, { fields: [paymentProviderCredentials.providerId], references: [paymentProviders.id] }),
  creator: one(users, { fields: [paymentProviderCredentials.createdBy], references: [users.id] }),
}));

export const paymentWebhookEndpointsRelations = relations(paymentWebhookEndpoints, ({ one, many }) => ({
  organization: one(organizations, { fields: [paymentWebhookEndpoints.orgId], references: [organizations.id] }),
  provider: one(paymentProviders, { fields: [paymentWebhookEndpoints.providerId], references: [paymentProviders.id] }),
  events: many(paymentWebhookEvents),
}));

export const paymentWebhookEventsRelations = relations(paymentWebhookEvents, ({ one }) => ({
  organization: one(organizations, { fields: [paymentWebhookEvents.orgId], references: [organizations.id] }),
  provider: one(paymentProviders, { fields: [paymentWebhookEvents.providerId], references: [paymentProviders.id] }),
}));

export const paymentTestTransactionsRelations = relations(paymentTestTransactions, ({ one }) => ({
  organization: one(organizations, { fields: [paymentTestTransactions.orgId], references: [organizations.id] }),
  provider: one(paymentProviders, { fields: [paymentTestTransactions.providerId], references: [paymentProviders.id] }),
  creator: one(users, { fields: [paymentTestTransactions.createdBy], references: [users.id] }),
}));

export const paymentAuditEventsRelations = relations(paymentAuditEvents, ({ one }) => ({
  organization: one(organizations, { fields: [paymentAuditEvents.orgId], references: [organizations.id] }),
  actor: one(users, { fields: [paymentAuditEvents.actorUserId], references: [users.id] }),
  provider: one(paymentProviders, { fields: [paymentAuditEvents.providerId], references: [paymentProviders.id] }),
}));

export const paymentManualMethodsRelations = relations(paymentManualMethods, ({ one }) => ({
  organization: one(organizations, { fields: [paymentManualMethods.orgId], references: [organizations.id] }),
}));
