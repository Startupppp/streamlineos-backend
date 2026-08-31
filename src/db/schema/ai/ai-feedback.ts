import { pgTable, pgEnum, serial, text, varchar, integer, jsonb, timestamp, index, foreignKey } from "drizzle-orm/pg-core";
import { organizations, users, organizationMembers } from "../common/auth";

export const aiFeedbackRatingEnum = pgEnum("ai_feedback_rating", ["UP", "DOWN"]);

export const aiFeedback = pgTable(
  "ai_feedback",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    userMembershipId: integer("user_membership_id"),
    feature: varchar("feature", { length: 100 }).notNull(),
    correlationId: varchar("correlation_id", { length: 64 }),
    entityType: varchar("entity_type", { length: 50 }),
    entityId: varchar("entity_id", { length: 50 }),
    rating: aiFeedbackRatingEnum("rating").notNull(),
    reason: text("reason"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_ai_feedback_org_feature_created").on(table.orgId, table.feature, table.createdAt),
    index("idx_ai_feedback_org_correlation").on(table.orgId, table.correlationId),
    foreignKey({
      columns: [table.orgId, table.userMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_ai_feedback_org_user_mbr",
    }).onDelete("set null"),
  ],
);
