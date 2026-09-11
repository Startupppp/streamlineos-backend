import { pgTable, text, serial, timestamp, boolean, jsonb, integer, index, unique, uniqueIndex, numeric, primaryKey, foreignKey } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import {
  subscriptionStatusEnum,
  subscriptionPlanEnum,
} from "./enums";
import { organizations, users, organizationMembers } from "./auth";

export const subscriptions = pgTable("subscriptions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  plan: subscriptionPlanEnum("plan").default("STARTER").notNull(),
  status: subscriptionStatusEnum("status").default("TRIAL").notNull(),
  razorpaySubscriptionId: text("razorpay_subscription_id"),
  razorpayCustomerId: text("razorpay_customer_id"),
  razorpayPlanId: text("razorpay_plan_id"),
  /**
   * The same references, without a provider's name on them.
   *
   * Expand half of ticket 02: written alongside the razorpay-named columns so a
   * second provider has somewhere to store while every existing reader keeps
   * working. Migration 0269 adds all three; the named columns are dropped once
   * no reader remains.
   */
  provider: text("provider"),
  providerSubscriptionRef: text("provider_subscription_ref"),
  providerCustomerRef: text("provider_customer_ref"),
  providerPlanRef: text("provider_plan_ref"),
  currentPeriodStart: timestamp("current_period_start"),
  currentPeriodEnd: timestamp("current_period_end"),
  trialEndsAt: timestamp("trial_ends_at"),
  cancelledAt: timestamp("cancelled_at"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_subscriptions_org").on(table.orgId),
  index("idx_subscriptions_status").on(table.status),
  index("idx_subscriptions_razorpay").on(table.razorpaySubscriptionId),
  unique("uniq_subscriptions_org_id").on(table.orgId, table.id),
]);

export const subscriptionPayments = pgTable("subscription_payments", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  subscriptionId: integer("subscription_id").references(() => subscriptions.id, { onDelete: "cascade" }).notNull(),
  razorpayPaymentId: text("razorpay_payment_id"),
  razorpayOrderId: text("razorpay_order_id"),
  /**
   * The same references, without a provider's name on them.
   *
   * Expand half of ticket 02: written alongside the razorpay-named columns so a
   * second provider has somewhere to store while every existing reader keeps
   * working. Migration 0269 adds all three; the named columns are dropped once
   * no reader remains.
   */
  provider: text("provider"),
  providerPaymentRef: text("provider_payment_ref"),
  providerOrderRef: text("provider_order_ref"),
  amount: numeric("amount", { precision: 15, scale: 2 }),
  amountPaise: integer("amount_paise").notNull(),
  currency: text("currency").default("INR").notNull(),
  status: text("status").notNull(),
  paidAt: timestamp("paid_at"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_subscription_payments_razorpay_payment").on(table.razorpayPaymentId).where(sql`razorpay_payment_id IS NOT NULL`),
  index("idx_sub_payments_org").on(table.orgId),
  index("idx_sub_payments_sub").on(table.subscriptionId),
  unique("uniq_subscription_payments_org_id").on(table.orgId, table.id),
]);

export const coupons = pgTable("coupons", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  type: text("type").$type<"PERCENTAGE" | "FIXED">().notNull(),
  value: numeric("value", { precision: 15, scale: 2 }).notNull(),
  minPurchase: numeric("min_purchase", { precision: 15, scale: 2 }),
  maxUses: integer("max_uses"),
  usedCount: integer("used_count").default(0).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  applicablePlans: jsonb("applicable_plans").$type<string[]>(),
  expiresAt: timestamp("expires_at"),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_coupons_code").on(table.code),
  index("idx_coupons_is_active").on(table.isActive),
  index("idx_coupons_org").on(table.orgId),
]);

export const couponRedemptions = pgTable("coupon_redemptions", {
  id: serial("id").primaryKey(),
  couponId: integer("coupon_id").references(() => coupons.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  membershipId: integer("membership_id"),
  amount: numeric("amount", { precision: 15, scale: 2 }),
  amountPaise: integer("amount_paise").notNull(),
  redeemedAt: timestamp("redeemed_at").defaultNow().notNull(),
}, (table) => [
  unique("uq_coupon_redemptions_coupon_org").on(table.couponId, table.orgId),
  index("idx_coupon_redemptions_coupon").on(table.couponId),
  index("idx_coupon_redemptions_org").on(table.orgId),
  index("idx_coupon_redemptions_org_membership").on(table.orgId, table.membershipId),
  unique("uniq_coupon_redemptions_org_id").on(table.orgId, table.id),
  foreignKey({
    name: "fk_coupon_redemptions_actor",
    columns: [table.orgId, table.membershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
  }).onDelete("set null"),
]);

export const subscriptionsRelations = relations(subscriptions, ({ one, many }) => ({
  organization: one(organizations, { fields: [subscriptions.orgId], references: [organizations.id] }),
  payments: many(subscriptionPayments),
}));

export const subscriptionPaymentsRelations = relations(subscriptionPayments, ({ one }) => ({
  subscription: one(subscriptions, { fields: [subscriptionPayments.subscriptionId], references: [subscriptions.id] }),
}));

export const couponsRelations = relations(coupons, ({ one, many }) => ({
  organization: one(organizations, { fields: [coupons.orgId], references: [organizations.id] }),
  redemptions: many(couponRedemptions),
}));

export const couponRedemptionsRelations = relations(couponRedemptions, ({ one }) => ({
  coupon: one(coupons, { fields: [couponRedemptions.couponId], references: [coupons.id] }),
  organization: one(organizations, { fields: [couponRedemptions.orgId], references: [organizations.id] }),
  user: one(users, { fields: [couponRedemptions.userId], references: [users.id] }),
}));
