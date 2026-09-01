import { pgTable, text, serial, integer, timestamp, index, unique, primaryKey, foreignKey } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, organizationMembers } from "./auth";

export const pushSubscriptions = pgTable("push_subscriptions", {
  id: serial("id").primaryKey(),
  // Stable delivery address projection; membershipId owns the subscription.
  userId: text("user_id").notNull(),
  membershipId: integer("membership_id"),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_push_subs_org_membership").on(table.orgId, table.membershipId),
  unique("uniq_push_subscriptions_org_id").on(table.orgId, table.id),
  foreignKey({
    name: "fk_push_subscriptions_actor",
    columns: [table.orgId, table.membershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
  }).onDelete("cascade"),
]);

export const pushSubscriptionsRelations = relations(pushSubscriptions, ({ one }) => ({
  membership: one(organizationMembers, { fields: [pushSubscriptions.orgId, pushSubscriptions.membershipId], references: [organizationMembers.orgId, organizationMembers.id] }),
}));
