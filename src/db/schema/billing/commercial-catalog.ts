import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { organizations, users } from "../common/auth";
import { subscriptions } from "../common/subscriptions";

export const billingProducts = pgTable(
  "billing_products",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    slug: varchar("slug", { length: 100 }).notNull().unique(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_billing_products_slug").on(t.slug),
    index("idx_billing_products_active").on(t.isActive),
  ],
);

export const billingPlans = pgTable(
  "billing_plans",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    productId: bigint("product_id", { mode: "number" }).notNull().references(() => billingProducts.id, { onDelete: "cascade" }),
    slug: varchar("slug", { length: 100 }).notNull(),
    displayName: varchar("display_name", { length: 255 }).notNull(),
    planTier: varchar("plan_tier", { length: 20 }).notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_billing_plans_product_slug").on(t.productId, t.slug),
    index("idx_billing_plans_product").on(t.productId),
    index("idx_billing_plans_tier").on(t.planTier),
  ],
);

export const billingPriceVersions = pgTable(
  "billing_price_versions",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    planId: bigint("plan_id", { mode: "number" }).notNull().references(() => billingPlans.id, { onDelete: "restrict" }),
    amountMinor: integer("amount_minor").notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    billingInterval: varchar("billing_interval", { length: 20 }).notNull(),
    taxBehavior: varchar("tax_behavior", { length: 20 }).notNull(),
    effectiveFrom: timestamp("effective_from").notNull(),
    effectiveUntil: timestamp("effective_until"),
    providerPriceId: text("provider_price_id"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    index("idx_billing_pv_plan_active").on(t.planId, t.isActive),
    index("idx_billing_pv_plan_effective").on(t.planId, t.effectiveFrom),
  ],
);

export const billingPlanEntitlements = pgTable(
  "billing_plan_entitlements",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    planId: bigint("plan_id", { mode: "number" }).notNull().references(() => billingPlans.id, { onDelete: "cascade" }),
    featureKey: varchar("feature_key", { length: 100 }).notNull(),
    limitValue: integer("limit_value"),
    effectiveFrom: timestamp("effective_from").notNull(),
    effectiveUntil: timestamp("effective_until"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_billing_plan_ent_plan_key_from").on(t.planId, t.featureKey, t.effectiveFrom),
    index("idx_billing_plan_ent_plan").on(t.planId),
    index("idx_billing_plan_ent_key").on(t.featureKey),
  ],
);

export const orgEntitlementOverrides = pgTable(
  "org_entitlement_overrides",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    featureKey: varchar("feature_key", { length: 100 }).notNull(),
    limitValue: integer("limit_value"),
    reason: text("reason"),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    idempotencyKey: varchar("idempotency_key", { length: 120 }),
    effectiveFrom: timestamp("effective_from").notNull(),
    effectiveUntil: timestamp("effective_until"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_org_ent_overrides_org_key_from").on(t.orgId, t.featureKey, t.effectiveFrom),
    uniqueIndex("uq_org_ent_overrides_idem").on(t.orgId, t.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
    index("idx_org_ent_overrides_org_key").on(t.orgId, t.featureKey),
    unique("uniq_org_entitlement_overrides_org_id").on(t.orgId, t.id),
  ],
);

export const subscriptionItems = pgTable(
  "subscription_items",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    subscriptionId: integer("subscription_id").notNull(),
    orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    priceVersionId: bigint("price_version_id", { mode: "number" }).notNull().references(() => billingPriceVersions.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull().default(1),
    effectiveFrom: timestamp("effective_from").notNull(),
    effectiveUntil: timestamp("effective_until"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_sub_items_org_sub").on(t.orgId, t.subscriptionId),
    index("idx_sub_items_org_active").on(t.orgId, t.effectiveFrom),
    unique("uniq_subscription_items_org_id").on(t.orgId, t.id),
    foreignKey({ columns: [t.orgId, t.subscriptionId], foreignColumns: [subscriptions.orgId, subscriptions.id], name: "fk_sub_items_org_sub" }).onDelete("cascade"),
  ],
);

export const billingProductsRelations = relations(billingProducts, ({ many }) => ({
  plans: many(billingPlans),
}));

export const billingPlansRelations = relations(billingPlans, ({ one, many }) => ({
  product: one(billingProducts, { fields: [billingPlans.productId], references: [billingProducts.id] }),
  priceVersions: many(billingPriceVersions),
  entitlements: many(billingPlanEntitlements),
}));

export const billingPriceVersionsRelations = relations(billingPriceVersions, ({ one, many }) => ({
  plan: one(billingPlans, { fields: [billingPriceVersions.planId], references: [billingPlans.id] }),
  subscriptionItems: many(subscriptionItems),
}));

export const billingPlanEntitlementsRelations = relations(billingPlanEntitlements, ({ one }) => ({
  plan: one(billingPlans, { fields: [billingPlanEntitlements.planId], references: [billingPlans.id] }),
}));

export const orgEntitlementOverridesRelations = relations(orgEntitlementOverrides, ({ one }) => ({
  organization: one(organizations, { fields: [orgEntitlementOverrides.orgId], references: [organizations.id] }),
  actor: one(users, { fields: [orgEntitlementOverrides.actorId], references: [users.id] }),
}));

export const subscriptionItemsRelations = relations(subscriptionItems, ({ one }) => ({
  subscription: one(subscriptions, { fields: [subscriptionItems.subscriptionId], references: [subscriptions.id] }),
  organization: one(organizations, { fields: [subscriptionItems.orgId], references: [organizations.id] }),
  priceVersion: one(billingPriceVersions, { fields: [subscriptionItems.priceVersionId], references: [billingPriceVersions.id] }),
}));
