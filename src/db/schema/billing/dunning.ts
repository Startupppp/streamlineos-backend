import { relations, sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, integer, pgTable, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";
import { subscriptions } from "../common/subscriptions";

export const dunningAttempts = pgTable(
  "dunning_attempts",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    subscriptionId: integer("subscription_id").notNull(),
    periodStart: timestamp("period_start").notNull(),
    milestone: text("milestone").notNull(),
    status: text("status").notNull().default("PENDING"),
    outcome: text("outcome"),
    notificationRef: text("notification_ref"),
    providerRetryId: text("provider_retry_id"),
    attemptedAt: timestamp("attempted_at").defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
  foreignKey({ columns: [t.orgId, t.subscriptionId], foreignColumns: [subscriptions.orgId, subscriptions.id], name: "fk_dunning_attempts_subscription_id_org" }).onDelete("cascade"),
    unique("uniq_dunning_attempts_org_id").on(t.orgId, t.id),
    uniqueIndex("uniq_dunning_attempt_cycle_milestone").on(
      t.orgId,
      t.subscriptionId,
      t.periodStart,
      t.milestone,
    ),
    index("idx_dunning_attempts_pending_milestone").on(t.milestone, t.orgId).where(
      sql`status = 'PENDING'`,
    ),
    check("chk_dunning_milestone", sql`${t.milestone} IN ('D+1','D+3','D+7','D+14')`),
    check("chk_dunning_status", sql`${t.status} IN ('PENDING','SENT','FAILED','SKIPPED')`),
    check(
      "chk_dunning_outcome",
      sql`${t.outcome} IS NULL OR ${t.outcome} IN ('PAYMENT_RECEIVED','NO_RESPONSE','BOUNCED','CANCELLED')`,
    ),
  ],
);

export const dunningAttemptsRelations = relations(dunningAttempts, ({ one }) => ({
  organization: one(organizations, {
    fields: [dunningAttempts.orgId],
    references: [organizations.id],
  }),
  subscription: one(subscriptions, {
    fields: [dunningAttempts.subscriptionId],
    references: [subscriptions.id],
  }),
}));
