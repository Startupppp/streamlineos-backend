import { pgTable, text, serial, timestamp, boolean, jsonb, integer, index, unique, uniqueIndex, numeric, primaryKey, foreignKey } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import {
  subscriptionStatusEnum,
  subscriptionPlanEnum,
} from "./enums";
import { organizations, organizationMembers } from "./auth";

export const subscriptions = pgTable("subscriptions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  plan: subscriptionPlanEnum("plan").default("STARTER").notNull(),
  status: subscriptionStatusEnum("status").default("TRIAL").notNull(),
  razorpaySubscriptionId: text("razorpay_subscription_id"),
  razorpayCustomerId: text("razorpay_customer_id"),
  razorpayPlanId: text("razorpay_plan_id"),
  currentPeriodStart: timestamp("current_period_start"),
  currentPeriodEnd: timestamp("current_period_end"),
  trialEndsAt: timestamp("trial_ends_at"),
  cancelledAt: timestamp("cancelled_at"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_subscriptions_status").on(table.status),
  index("idx_subscriptions_razorpay").on(table.razorpaySubscriptionId),
  unique("uniq_subscriptions_org_id").on(table.orgId, table.id),
]);

export const subscriptionPayments = pgTable("subscription_payments", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  subscriptionId: integer("subscription_id").notNull(),
  razorpayPaymentId: text("razorpay_payment_id"),
  razorpayOrderId: text("razorpay_order_id"),
  amount: numeric("amount", { precision: 15, scale: 2 }),
  amountPaise: integer("amount_paise").notNull(),
  currency: text("currency").default("INR").notNull(),
  status: text("status").notNull(),
  paidAt: timestamp("paid_at"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_subscription_payments_razorpay_payment").on(table.razorpayPaymentId).where(sql`razorpay_payment_id IS NOT NULL`),
  index("idx_sub_payments_sub").on(table.subscriptionId),
  unique("uniq_subscription_payments_org_id").on(table.orgId, table.id),
  foreignKey({ columns: [table.orgId, table.subscriptionId], foreignColumns: [subscriptions.orgId, subscriptions.id], name: "fk_sub_payments_org_sub" }).onDelete("cascade"),
]);

export const coupons = pgTable("coupons", {
  id: serial("id").primaryKey(),
  code: text("code").notNull(),
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
  // Tenant-scoped, not global: a global UNIQUE(code) lets the first org to claim
  // a code deny it to every other org and turn the 409 into an existence oracle.
  uniqueIndex("uniq_coupons_platform_code").on(table.code).where(sql`org_id IS NULL`),
  uniqueIndex("uniq_coupons_org_code").on(table.orgId, table.code).where(sql`org_id IS NOT NULL`),
  index("idx_coupons_is_active").on(table.isActive),
]);

export const couponRedemptions = pgTable("coupon_redemptions", {
  id: serial("id").primaryKey(),
  couponId: integer("coupon_id").notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  // Historical redemption display projection; membershipId is authoritative.
  userId: text("user_id"),
  membershipId: integer("membership_id"),
  amount: numeric("amount", { precision: 15, scale: 2 }),
  amountPaise: integer("amount_paise").notNull(),
  redeemedAt: timestamp("redeemed_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.couponId], foreignColumns: [coupons.orgId, coupons.id], name: "fk_coupon_redemptions_coupon_id_org" }).onDelete("cascade"),
  unique("uq_coupon_redemptions_coupon_org").on(table.couponId, table.orgId),
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
  membership: one(organizationMembers, { fields: [couponRedemptions.orgId, couponRedemptions.membershipId], references: [organizationMembers.orgId, organizationMembers.id] }),
}));
