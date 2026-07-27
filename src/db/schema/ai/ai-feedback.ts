import { pgTable, pgEnum, serial, text, varchar, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { organizations, users } from "../common/auth";

export const aiFeedbackRatingEnum = pgEnum("ai_feedback_rating", ["UP", "DOWN"]);

export const aiFeedback = pgTable(
  "ai_feedback",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
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
  ],
);

export type AiFeedback = typeof aiFeedback.$inferSelect;
export type NewAiFeedback = typeof aiFeedback.$inferInsert;
