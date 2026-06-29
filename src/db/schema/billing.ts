import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import {
  affiliateStatusEnum,
  aiCreditTxnTypeEnum,
  appInstallStatusEnum,
  commissionStatusEnum,
  referralStatusEnum,
  revenueEventTypeEnum,
} from "./enums";

export const billingProfiles = pgTable(
  "billing_profiles",
  {
    id: serial("id").primaryKey(),
    orgId: integer("org_id").notNull().unique(),
    gstin: varchar("gstin", { length: 15 }),
    pan: varchar("pan", { length: 10 }),
    billingName: varchar("billing_name", { length: 255 }),
    billingEmail: varchar("billing_email", { length: 255 }),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    city: varchar("city", { length: 100 }),
    state: varchar("state", { length: 100 }),
    pincode: varchar("pincode", { length: 10 }),
    country: varchar("country", { length: 2 }).default("IN"),
    isTaxExempt: boolean("is_tax_exempt").default(false).notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [index("billing_profiles_org_idx").on(t.orgId)],
);

export const marketplaceApps = pgTable(
  "marketplace_apps",
  {
    id: serial("id").primaryKey(),
    slug: varchar("slug", { length: 100 }).notNull().unique(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    category: varchar("category", { length: 50 }).notNull(),
    iconUrl: text("icon_url"),
    screenshotUrls: jsonb("screenshot_urls").$type<string[]>().default([]),
    features: jsonb("features").$type<string[]>().default([]),
    pricingType: varchar("pricing_type", { length: 20 }).notNull().default("free"),
    monthlyPrice: integer("monthly_price").default(0).notNull(),
    annualPrice: integer("annual_price").default(0).notNull(),
    trialDays: integer("trial_days").default(0).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    requiredPlan: varchar("required_plan", { length: 20 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("marketplace_apps_category_idx").on(t.category),
    index("marketplace_apps_active_idx").on(t.isActive),
  ],
);

export const appInstallations = pgTable(
  "app_installations",
  {
    id: serial("id").primaryKey(),
    orgId: integer("org_id").notNull(),
    appId: integer("app_id").notNull(),
    installedBy: integer("installed_by").notNull(),
    status: appInstallStatusEnum("status").notNull().default("ACTIVE"),
    trialEndsAt: timestamp("trial_ends_at"),
    installedAt: timestamp("installed_at").defaultNow().notNull(),
    cancelledAt: timestamp("cancelled_at"),
  },
  (t) => [
    index("app_installations_org_app_idx").on(t.orgId, t.appId),
    index("app_installations_org_idx").on(t.orgId),
  ],
);

export const aiCreditPacks = pgTable("ai_credit_packs", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  credits: integer("credits").notNull(),
  bonusCredits: integer("bonus_credits").default(0).notNull(),
  priceInPaise: integer("price_in_paise").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const orgAiCredits = pgTable(
  "org_ai_credits",
  {
    id: serial("id").primaryKey(),
    orgId: integer("org_id").notNull().unique(),
    balance: integer("balance").default(0).notNull(),
    lifetimeGranted: integer("lifetime_granted").default(0).notNull(),
    lifetimeConsumed: integer("lifetime_consumed").default(0).notNull(),
    autoTopUpEnabled: boolean("auto_top_up_enabled").default(false).notNull(),
    autoTopUpPackId: integer("auto_top_up_pack_id"),
    autoTopUpThreshold: integer("auto_top_up_threshold").default(100),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [index("org_ai_credits_org_idx").on(t.orgId)],
);

export const aiCreditTransactions = pgTable(
  "ai_credit_transactions",
  {
    id: serial("id").primaryKey(),
    orgId: integer("org_id").notNull(),
    userId: integer("user_id"),
    type: aiCreditTxnTypeEnum("type").notNull(),
    amount: integer("amount").notNull(),
    balanceAfter: integer("balance_after").notNull(),
    feature: varchar("feature", { length: 100 }),
    model: varchar("model", { length: 100 }),
    referenceId: varchar("reference_id", { length: 100 }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("ai_credit_txns_org_idx").on(t.orgId),
    index("ai_credit_txns_org_created_idx").on(t.orgId, t.createdAt),
  ],
);

export const affiliates = pgTable(
  "affiliates",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().unique(),
    orgId: integer("org_id").notNull(),
    referralCode: varchar("referral_code", { length: 20 }).notNull().unique(),
    status: affiliateStatusEnum("status").notNull().default("PENDING"),
    commissionType: varchar("commission_type", { length: 20 }).notNull().default("PERCENTAGE"),
    commissionRate: integer("commission_rate").notNull().default(10),
    totalEarned: integer("total_earned").default(0).notNull(),
    totalPaid: integer("total_paid").default(0).notNull(),
    pendingPayout: integer("pending_payout").default(0).notNull(),
    clickCount: integer("click_count").default(0).notNull(),
    signupCount: integer("signup_count").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("affiliates_code_idx").on(t.referralCode),
    index("affiliates_user_idx").on(t.userId),
  ],
);

export const affiliateCommissions = pgTable(
  "affiliate_commissions",
  {
    id: serial("id").primaryKey(),
    affiliateId: integer("affiliate_id").notNull(),
    referredOrgId: integer("referred_org_id").notNull(),
    subscriptionId: integer("subscription_id"),
    amountInPaise: integer("amount_in_paise").notNull(),
    status: commissionStatusEnum("status").notNull().default("PENDING"),
    paidAt: timestamp("paid_at"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("affiliate_commissions_affiliate_idx").on(t.affiliateId),
    index("affiliate_commissions_status_idx").on(t.status),
  ],
);

export const referrals = pgTable(
  "referrals",
  {
    id: serial("id").primaryKey(),
    referrerOrgId: integer("referrer_org_id").notNull(),
    referrerUserId: integer("referrer_user_id").notNull(),
    referredEmail: varchar("referred_email", { length: 255 }).notNull(),
    referredOrgId: integer("referred_org_id"),
    referralCode: varchar("referral_code", { length: 20 }).notNull(),
    status: referralStatusEnum("status").notNull().default("PENDING"),
    rewardGranted: boolean("reward_granted").default(false).notNull(),
    signedUpAt: timestamp("signed_up_at"),
    activatedAt: timestamp("activated_at"),
    rewardedAt: timestamp("rewarded_at"),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("referrals_referrer_idx").on(t.referrerOrgId),
    index("referrals_code_idx").on(t.referralCode),
    index("referrals_email_idx").on(t.referredEmail),
  ],
);

export const revenueEvents = pgTable(
  "revenue_events",
  {
    id: serial("id").primaryKey(),
    type: revenueEventTypeEnum("type").notNull(),
    orgId: integer("org_id").notNull(),
    plan: varchar("plan", { length: 20 }),
    previousPlan: varchar("previous_plan", { length: 20 }),
    mrr: integer("mrr").notNull(),
    amount: integer("amount"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("revenue_events_type_idx").on(t.type),
    index("revenue_events_created_idx").on(t.createdAt),
    index("revenue_events_org_idx").on(t.orgId),
  ],
);

export const marketplaceAppsRelations = relations(marketplaceApps, ({ many }) => ({
  installations: many(appInstallations),
}));

export const appInstallationsRelations = relations(appInstallations, ({ one }) => ({
  app: one(marketplaceApps, {
    fields: [appInstallations.appId],
    references: [marketplaceApps.id],
  }),
}));

export const affiliatesRelations = relations(affiliates, ({ many }) => ({
  commissions: many(affiliateCommissions),
}));

export const affiliateCommissionsRelations = relations(affiliateCommissions, ({ one }) => ({
  affiliate: one(affiliates, {
    fields: [affiliateCommissions.affiliateId],
    references: [affiliates.id],
  }),
}));
