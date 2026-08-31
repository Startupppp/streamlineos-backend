import { relations, sql } from "drizzle-orm";
import {
  bigint,
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
import { billingPriceVersions } from "./commercial-catalog";

export const billingProrationLines = pgTable(
  "billing_proration_lines",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    subscriptionId: integer("subscription_id").notNull().references(() => subscriptions.id, { onDelete: "cascade" }),
    idempotencyKey: varchar("idempotency_key", { length: 120 }).notNull(),
    lineType: varchar("line_type", { length: 20 }).notNull(),
    oldPriceVersionId: bigint("old_price_version_id", { mode: "number" }).references(() => billingPriceVersions.id, { onDelete: "restrict" }),
    newPriceVersionId: bigint("new_price_version_id", { mode: "number" }).references(() => billingPriceVersions.id, { onDelete: "restrict" }),
    effectiveFrom: timestamp("effective_from").notNull(),
    effectiveUntil: timestamp("effective_until").notNull(),
    quantity: integer("quantity").notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    amountMinor: integer("amount_minor").notNull(),
    roundingRule: varchar("rounding_rule", { length: 10 }).notNull().default("HALF_UP"),
    providerAmountMinor: integer("provider_amount_minor"),
    providerRef: text("provider_ref"),
    reconciledAt: timestamp("reconciled_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    uniqueIndex("uq_billing_proration_org_idem").on(t.orgId, t.idempotencyKey),
    index("idx_billing_proration_org_sub").on(t.orgId, t.subscriptionId),
    index("idx_billing_proration_org_from").on(t.orgId, t.effectiveFrom),
    index("idx_billing_proration_unreconciled").on(t.orgId)
      .where(sql`reconciled_at IS NULL AND provider_ref IS NOT NULL`),
    unique("uniq_billing_proration_lines_org_id").on(t.orgId, t.id),
  ],
);

export const billingProrationLinesRelations = relations(billingProrationLines, ({ one }) => ({
  organization: one(organizations, { fields: [billingProrationLines.orgId], references: [organizations.id] }),
  subscription: one(subscriptions, { fields: [billingProrationLines.subscriptionId], references: [subscriptions.id] }),
  oldPriceVersion: one(billingPriceVersions, {
    fields: [billingProrationLines.oldPriceVersionId],
    references: [billingPriceVersions.id],
    relationName: "proration_old_price",
  }),
  newPriceVersion: one(billingPriceVersions, {
    fields: [billingProrationLines.newPriceVersionId],
    references: [billingPriceVersions.id],
    relationName: "proration_new_price",
  }),
  createdByUser: one(users, { fields: [billingProrationLines.createdBy], references: [users.id] }),
}));
