import { pgTable, text, serial, timestamp, jsonb, integer, index, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import {
  notificationTypeEnum,
  notificationPriorityEnum,
  notificationCategoryEnum,
  broadcastStatusEnum,
  broadcastAudienceTypeEnum,
} from "./enums";
import { organizations, users } from "./auth";

export const broadcasts = pgTable("broadcasts", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  type: notificationTypeEnum("type").default("INFO").notNull(),
  priority: notificationPriorityEnum("priority").default("NORMAL").notNull(),
  category: notificationCategoryEnum("category").default("SYSTEM").notNull(),
  channels: jsonb("channels").$type<string[]>().default(["IN_APP"]).notNull(),
  // SCH-017: the ids now live in broadcast_audience_targets and the discriminator in
  // audienceType. This column is still written during expand-contract; it is no longer
  // read to resolve recipients.
  audience: jsonb("audience").$type<{
    type: "all" | "roles" | "departments" | "users";
    roleIds?: string[];
    departmentIds?: string[];
    userIds?: string[];
  }>().notNull(),
  audienceType: broadcastAudienceTypeEnum("audience_type").default("all").notNull(),
  status: broadcastStatusEnum("status").default("DRAFT").notNull(),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  recipientCount: integer("recipient_count").default(0).notNull(),
  deliveredCount: integer("delivered_count").default(0).notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_broadcasts_org_status").on(table.orgId, table.status),
  index("idx_broadcasts_scheduled").on(table.scheduledAt),
  index("idx_broadcasts_created_by").on(table.createdBy),
  unique("uniq_broadcasts_org_id").on(table.orgId, table.id),
]);

export const broadcastsRelations = relations(broadcasts, ({ one }) => ({
  organization: one(organizations, { fields: [broadcasts.orgId], references: [organizations.id] }),
  createdByUser: one(users, { fields: [broadcasts.createdBy], references: [users.id] }),
}));
