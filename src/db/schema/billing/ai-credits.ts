/**
 * The AI credit ledger: what an organisation has bought, holds, reserved and
 * spent.
 *
 * A pack is the SKU, `org_ai_credits` is the balance, and the transaction log
 * is every movement of it. `ai_credit_reservations` is the half that makes the
 * balance trustworthy: §4 requires credits to be reserved BEFORE a paid provider
 * call and settled or released after, never checked-then-spent, so a reservation
 * is a row with its own lifecycle rather than a number held in a request.
 *
 * Split out of `billing.ts` verbatim. Metered consumption is a different subject
 * from the SaaS billing profile, the marketplace and the affiliate programme
 * that remain there, and nothing in either half references the other.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { aiCreditReservationStatusEnum, aiCreditTxnTypeEnum } from "../common/enums";
import { organizations, users } from "../common/auth";

export const aiCreditPacks = pgTable(
  "ai_credit_packs",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 100 }).notNull(),
    credits: integer("credits").notNull(),
    bonusCredits: integer("bonus_credits").default(0).notNull(),
    priceInPaise: integer("price_in_paise").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uniq_ai_credit_packs_name").on(t.name)],
);

export const orgAiCredits = pgTable(
  "org_ai_credits",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").notNull().unique().references(() => organizations.id, { onDelete: "cascade" }),
    balance: integer("balance").default(0).notNull(),
    lifetimeGranted: integer("lifetime_granted").default(0).notNull(),
    lifetimeConsumed: integer("lifetime_consumed").default(0).notNull(),
    autoTopUpEnabled: boolean("auto_top_up_enabled").default(false).notNull(),
    autoTopUpPackId: integer("auto_top_up_pack_id").references(() => aiCreditPacks.id, { onDelete: "set null" }),
    autoTopUpThreshold: integer("auto_top_up_threshold").default(100000),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("org_ai_credits_org_idx").on(t.orgId),
    unique("uniq_org_ai_credits_org_id").on(t.orgId, t.id),
  ],
);

export const aiCreditTransactions = pgTable(
  "ai_credit_transactions",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    type: aiCreditTxnTypeEnum("type").notNull(),
    amount: integer("amount").notNull(),
    balanceAfter: integer("balance_after").notNull(),
    feature: varchar("feature", { length: 100 }),
    model: varchar("model", { length: 100 }),
    referenceId: varchar("reference_id", { length: 100 }),
    metadata: jsonb("metadata"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    totalTokens: integer("total_tokens"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("ai_credit_txns_org_idx").on(t.orgId),
    index("ai_credit_txns_org_created_idx").on(t.orgId, t.createdAt),
    uniqueIndex("uq_ai_credit_txns_plan_grant_ref").on(t.orgId, t.referenceId).where(sql`type = 'PLAN_GRANT' AND reference_id IS NOT NULL`),
    uniqueIndex("uq_ai_credit_txns_purchase_ref").on(t.orgId, t.referenceId).where(sql`type = 'PURCHASE' AND reference_id IS NOT NULL`),
    unique("uniq_ai_credit_transactions_org_id").on(t.orgId, t.id),
  ],
);

export const aiCreditReservations = pgTable(
  "ai_credit_reservations",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    feature: varchar("feature", { length: 100 }).notNull(),
    credits: integer("credits").notNull(),
    status: aiCreditReservationStatusEnum("status").notNull().default("RESERVED"),
    idempotencyKey: varchar("idempotency_key", { length: 120 }),
    model: varchar("model", { length: 100 }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (t) => [
    index("ai_credit_res_org_created_idx").on(t.orgId, t.createdAt),
    index("ai_credit_res_status_expires_idx").on(t.status, t.expiresAt),
    uniqueIndex("uq_ai_credit_res_org_idem_key")
      .on(t.orgId, t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    unique("uniq_ai_credit_reservations_org_id").on(t.orgId, t.id),
  ],
);
