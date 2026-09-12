import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { subscriptionPlanEnum } from "../common/enums";
import { organizations, users } from "../common/auth";
import { coupons } from "../common/subscriptions";

export const SUBSCRIPTION_PURCHASE_EXPIRY_MINUTES = 30;

export type SubscriptionPurchaseStatus =
  | "PENDING"
  | "CAPTURED"
  | "ACTIVATED"
  | "CANCELLED"
  | "EXPIRED"
  | "FAILED";

export const subscriptionPurchases = pgTable(
  "subscription_purchases",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").notNull(),
    createdByUserId: text("created_by_user_id"),
    providerKey: varchar("provider_key", { length: 50 }).notNull(),
    environment: varchar("environment", { length: 10 }).notNull(),
    merchantKeyId: varchar("merchant_key_id", { length: 120 }).notNull(),
    providerOrderId: text("provider_order_id").notNull(),
    plan: subscriptionPlanEnum("plan").notNull(),
    billingCycle: varchar("billing_cycle", { length: 10 }).notNull(),
    catalogVersion: integer("catalog_version"),
    baseAmountMinor: integer("base_amount_minor").notNull(),
    discountAmountMinor: integer("discount_amount_minor").notNull().default(0),
    amountMinor: integer("amount_minor").notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    couponId: integer("coupon_id"),
    status: varchar("status", { length: 20 }).notNull().default("PENDING"),
    providerPaymentId: text("provider_payment_id"),
    capturedAmountMinor: integer("captured_amount_minor"),
    capturedCurrency: varchar("captured_currency", { length: 3 }),
    subscriptionId: integer("subscription_id"),
    activatedAt: timestamp("activated_at"),
    expiresAt: timestamp("expires_at").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    unique("uniq_subscription_purchases_org_id").on(t.orgId, t.id),
    unique("uniq_subscription_purchases_order").on(t.providerOrderId),
    uniqueIndex("uniq_subscription_purchases_payment_id")
      .on(t.providerPaymentId)
      .where(sql`provider_payment_id IS NOT NULL`),
    index("idx_subscription_purchases_org_status").on(t.orgId, t.status, t.createdAt),
    foreignKey({
      name: "fk_subscription_purchases_org",
      columns: [t.orgId],
      foreignColumns: [organizations.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_subscription_purchases_user",
      columns: [t.createdByUserId],
      foreignColumns: [users.id],
    }).onDelete("set null"),
    foreignKey({
      name: "fk_subscription_purchases_coupon",
      columns: [t.couponId],
      foreignColumns: [coupons.id],
    }).onDelete("set null"),
  ],
);

export type SubscriptionPurchase = typeof subscriptionPurchases.$inferSelect;
export type NewSubscriptionPurchase = typeof subscriptionPurchases.$inferInsert;
