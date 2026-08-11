import { bigint, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./auth";
import { notificationChannelEnum } from "./enums";

export type EmailOutboxStatus = "PENDING" | "SENT" | "FAILED" | "DEAD" | "SUPPRESSED";

export const emailOutbox = pgTable(
  "email_outbox",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id"),
    toEmail: text("to_email").notNull(),
    subject: text("subject").notNull(),
    html: text("html").notNull(),
    text: text("text"),
    status: text("status").$type<EmailOutboxStatus>().notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("email_outbox_status_next_idx").on(t.status, t.nextAttemptAt),
    index("email_outbox_email_created_idx").on(t.toEmail, t.createdAt),
    index("email_outbox_org_idx").on(t.organizationId, t.status),
  ],
);

export const emailSuppressionReasonEnum = pgEnum("email_suppression_reason", [
  "HARD_BOUNCE", "COMPLAINT", "UNSUBSCRIBE", "MANUAL", "INVALID_ADDRESS",
]);

export const emailSuppressionSourceEnum = pgEnum("email_suppression_source", [
  "PROVIDER_WEBHOOK", "USER", "ADMIN", "IMPORT",
]);

/**
 * SEC-002/SEC-003. Checked before every send at the one choke point every email
 * passes through (`EmailOutboxService.enqueueAndTry`).
 *
 * Keyed on the address, not a user FK: `notification_suppression_rules` cascades on
 * user delete, so purging a user would resurrect their bounced address. A hard
 * bounce must outlive the account.
 *
 * `org_id IS NULL` means platform-wide — the correct scope for a hard bounce, which
 * is a property of the address. A tenant may additionally suppress for itself.
 */
export const emailSuppressions = pgTable(
  "email_suppressions",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    email: text("email").notNull(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    channel: notificationChannelEnum("channel").notNull().default("EMAIL"),
    reason: emailSuppressionReasonEnum("reason").notNull(),
    source: emailSuppressionSourceEnum("source").notNull(),
    evidence: jsonb("evidence"),
    suppressedAt: timestamp("suppressed_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [
    // Two partial uniques, not one nullable composite: NULL <> NULL in a btree
    // unique would leave the platform-wide rows unconstrained (the SCH-013 defect).
    uniqueIndex("uniq_email_suppressions_global")
      .on(t.email, t.channel)
      .where(sql`${t.orgId} is null`),
    uniqueIndex("uniq_email_suppressions_org")
      .on(t.orgId, t.email, t.channel)
      .where(sql`${t.orgId} is not null`),
    index("idx_email_suppressions_lookup").on(t.email, t.channel, t.expiresAt),
  ],
);
