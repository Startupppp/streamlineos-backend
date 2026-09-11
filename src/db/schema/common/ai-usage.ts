import { pgTable, text, serial, timestamp, jsonb, integer, index, unique, numeric, varchar } from "drizzle-orm/pg-core";
import { organizations, users } from "./auth";

export const aiUsageLogs = pgTable("ai_usage_logs", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  feature: text("feature").notNull(),
  model: text("model").notNull(),
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  estimatedCostUsd: numeric("estimated_cost_usd", { precision: 12, scale: 6 }),
  creditsMilli: integer("credits_milli").notNull().default(0),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  latencyMs: integer("latency_ms"),
  correlationId: varchar("correlation_id", { length: 64 }),
  outcome: varchar("outcome", { length: 20 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_ai_usage_org_feature").on(table.orgId, table.feature),
  index("idx_ai_usage_org_created").on(table.orgId, table.createdAt),
  index("idx_ai_usage_user").on(table.userId),
  unique("uniq_ai_usage_logs_org_id").on(table.orgId, table.id),
]);
