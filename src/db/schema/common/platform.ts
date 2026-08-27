import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { organizations, users } from "./auth";

export const platformMessages = pgTable(
  "platform_messages",
  {
    id: serial("id").primaryKey(),
    publicCode: text("public_code").notNull().unique(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    company: text("company"),
    phone: text("phone"),
    topic: text("topic").default("sales").notNull(),
    message: text("message").notNull(),
    status: text("status").default("NEW").notNull(),
    repliedAt: timestamp("replied_at"),
    repliedById: text("replied_by_id").references(() => users.id),
    replyBody: text("reply_body"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    referrerUrl: text("referrer_url"),
    utm: jsonb("utm").$type<Record<string, string | null>>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_platform_messages_status").on(table.status),
    index("idx_platform_messages_topic").on(table.topic),
    index("idx_platform_messages_created").on(table.createdAt),
    index("idx_platform_messages_email").on(table.email),
  ],
);

export const platformWaitlist = pgTable(
  "platform_waitlist",
  {
    id: serial("id").primaryKey(),
    publicCode: text("public_code").notNull().unique(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    organization: text("organization"),
    role: text("role"),
    teamSize: text("team_size"),
    notes: text("notes"),
    status: text("status").default("PENDING").notNull(),
    invitedAt: timestamp("invited_at"),
    /**
     * The admission token, hashed.
     *
     * Ticket 13. A backup should not contain live credentials for creating
     * organisations, so only the digest is stored and the raw value exists in
     * the email that carried it. Same treatment as `invitations.token_hash`.
     */
    tokenHash: text("token_hash"),
    tokenExpiresAt: timestamp("token_expires_at"),
    admittedByUserId: text("admitted_by_user_id"),
    /**
     * Distinct from `invited_at`, which is what the notification used.
     *
     * Conflating "we told them" with "we let them in" makes the funnel
     * unmeasurable the first time a send fails.
     */
    admittedAt: timestamp("admitted_at"),
    claimedAt: timestamp("claimed_at"),
    claimedOrgId: text("claimed_org_id"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    referrerUrl: text("referrer_url"),
    utm: jsonb("utm").$type<Record<string, string | null>>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_platform_waitlist_email").on(table.email),
    index("idx_platform_waitlist_status").on(table.status),
    index("idx_platform_waitlist_created").on(table.createdAt),
    uniqueIndex("uniq_platform_waitlist_token").on(table.tokenHash),
    index("idx_platform_waitlist_admitted").on(table.admittedAt),
  ],
);

export const platformVisits = pgTable(
  "platform_visits",
  {
    id: serial("id").primaryKey(),
    sessionToken: text("session_token").notNull(),
    path: text("path").notNull(),
    referrer: text("referrer"),
    userAgent: text("user_agent"),
    country: text("country"),
    isFirstVisit: boolean("is_first_visit").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_platform_visits_session").on(table.sessionToken),
    index("idx_platform_visits_path").on(table.path),
    index("idx_platform_visits_created").on(table.createdAt),
  ],
);

export const platformPayments = pgTable(
  "platform_payments",
  {
    id: serial("id").primaryKey(),
    /**
     * Nullable since `0531`. A Stripe payment has no Razorpay id, and this being
     * NOT NULL is what actually blocked the second provider -- not the missing
     * credentials ticket 02's status line blamed. Rows written by any provider
     * carry `providerPaymentRef`; this one carries a value only for Razorpay.
     */
    razorpayPaymentId: text("razorpay_payment_id"),
    razorpayOrderId: text("razorpay_order_id"),
    razorpaySignature: text("razorpay_signature"),
    /** Ticket 02's expand half; see subscriptions in common/shared.ts. */
    provider: text("provider"),
    providerPaymentRef: text("provider_payment_ref"),
    providerOrderRef: text("provider_order_ref"),
    providerSignature: text("provider_signature"),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "set null" }),
    customerEmail: text("customer_email"),
    amount: integer("amount").notNull(),
    currency: text("currency").default("INR").notNull(),
    status: text("status").notNull(),
    method: text("method"),
    description: text("description"),
    invoiceUrl: text("invoice_url"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    capturedAt: timestamp("captured_at"),
    refundedAt: timestamp("refunded_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    // Partial, matching `0531`: it constrains the rows that carry a Razorpay id.
    uniqueIndex("uniq_platform_payments_razorpay_payment")
      .on(table.razorpayPaymentId)
      .where(sql`razorpay_payment_id IS NOT NULL`),
    /*
      What makes a duplicate webhook idempotent for EVERY provider. Created by
      `0269` but never declared here, so the schema and the database disagreed
      about what uniqueness this table has.
    */
    uniqueIndex("uniq_platform_payments_provider_ref")
      .on(table.provider, table.providerPaymentRef)
      .where(sql`provider_payment_ref IS NOT NULL`),
    index("idx_platform_payments_status").on(table.status),
    index("idx_platform_payments_org").on(table.orgId),
    index("idx_platform_payments_created").on(table.createdAt),
  ],
);

export const platformSubscriptions = pgTable(
  "platform_subscriptions",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    plan: text("plan").notNull(),
    seatCount: integer("seat_count").default(1).notNull(),
    status: text("status").default("active").notNull(),
    razorpaySubscriptionId: text("razorpay_subscription_id"),
    currentPeriodStart: timestamp("current_period_start"),
    currentPeriodEnd: timestamp("current_period_end"),
    cancelledAt: timestamp("cancelled_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_platform_subscriptions_org").on(table.orgId),
    index("idx_platform_subscriptions_status").on(table.status),
    unique("uniq_platform_subscriptions_org_id").on(table.orgId, table.id),
  ],
);

export const platformMessagesRelations = relations(platformMessages, ({ one }) => ({
  repliedBy: one(users, {
    fields: [platformMessages.repliedById],
    references: [users.id],
  }),
}));

export const platformPaymentsRelations = relations(platformPayments, ({ one }) => ({
  org: one(organizations, {
    fields: [platformPayments.orgId],
    references: [organizations.id],
  }),
}));

export const platformSubscriptionsRelations = relations(platformSubscriptions, ({ one }) => ({
  org: one(organizations, {
    fields: [platformSubscriptions.orgId],
    references: [organizations.id],
  }),
}));

