import {
  pgTable,
  text,
  serial,
  timestamp,
  boolean,
  jsonb,
  integer,
  index,
  unique,
  uniqueIndex,
  pgEnum,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../auth";

export const hrWebhookDeliveryStatusEnum = pgEnum("hr_webhook_delivery_status", [
  "pending",
  "delivered",
  "failed",
  "dead",
]);

export const hrWebhookSubscriptions = pgTable(
  "hr_webhook_subscriptions",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    secret: text("secret").notNull(),
    events: text("events").array().notNull().default([]),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    unique("uniq_hr_webhook_subscriptions_org_id").on(table.orgId, table.id),
    uniqueIndex("uniq_hr_webhook_subscriptions_org_name").on(table.orgId, table.name),
    index("idx_hr_webhook_subscriptions_org_active").on(table.orgId, table.isActive),
  ],
);

export const hrWebhookDeliveries = pgTable(
  "hr_webhook_deliveries",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    subscriptionId: integer("subscription_id")
      .references(() => hrWebhookSubscriptions.id, { onDelete: "cascade" })
      .notNull(),
    event: text("event").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: hrWebhookDeliveryStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at"),
    responseStatus: integer("response_status"),
    error: text("error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("uniq_hr_webhook_deliveries_org_id").on(table.orgId, table.id),
    index("idx_hr_webhook_deliveries_org_sub_created").on(
      table.orgId,
      table.subscriptionId,
      table.createdAt,
    ),
    index("idx_hr_webhook_deliveries_org_status").on(table.orgId, table.status),
  ],
);

export const hrWebhookSubscriptionsRelations = relations(hrWebhookSubscriptions, ({ many }) => ({
  deliveries: many(hrWebhookDeliveries),
}));

export const hrWebhookDeliveriesRelations = relations(hrWebhookDeliveries, ({ one }) => ({
  subscription: one(hrWebhookSubscriptions, {
    fields: [hrWebhookDeliveries.subscriptionId],
    references: [hrWebhookSubscriptions.id],
  }),
}));
