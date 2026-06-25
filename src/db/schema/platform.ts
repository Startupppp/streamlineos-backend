import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
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
    razorpayPaymentId: text("razorpay_payment_id").notNull(),
    razorpayOrderId: text("razorpay_order_id"),
    razorpaySignature: text("razorpay_signature"),
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
    uniqueIndex("uniq_platform_payments_razorpay_payment").on(table.razorpayPaymentId),
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

export type PlatformMessage = typeof platformMessages.$inferSelect;
export type PlatformMessageStatus = "NEW" | "READ" | "REPLIED" | "ARCHIVED";
export type PlatformMessageTopic = "sales" | "support" | "partnership" | "press" | "other";
export type PlatformVisit = typeof platformVisits.$inferSelect;
export type PlatformPayment = typeof platformPayments.$inferSelect;
export type PlatformSubscription = typeof platformSubscriptions.$inferSelect;
