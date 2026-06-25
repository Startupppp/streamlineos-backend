import { pgTable, pgEnum, text, serial, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../auth";
import { clientAccounts } from "./contacts";

export const clientHealthStatusEnum = pgEnum("client_health_status", ["healthy", "at_risk", "critical"]);

export interface HealthScoreWeights {
  sla: number;
  csat: number;
  activity: number;
  renewal: number;
  tickets: number;
}

export interface HealthScoreThresholds {
  healthy: number;
  atRisk: number;
}

export interface HealthScoreBreakdown {
  sla: number;
  csat: number;
  activity: number;
  renewal: number;
  tickets: number;
}

export const healthScoreConfig = pgTable("health_score_config", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull().unique(),
  weights: jsonb("weights").$type<HealthScoreWeights>().notNull(),
  thresholds: jsonb("thresholds").$type<HealthScoreThresholds>().notNull(),
  updatedBy: text("updated_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_health_score_config_org").on(table.orgId),
]);

export const clientHealthScores = pgTable("client_health_scores", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  clientAccountId: integer("client_account_id").references(() => clientAccounts.id, { onDelete: "cascade" }).notNull(),
  score: integer("score").notNull(),
  status: clientHealthStatusEnum("status").notNull(),
  breakdown: jsonb("breakdown").$type<HealthScoreBreakdown>().notNull(),
  computedAt: timestamp("computed_at").defaultNow().notNull(),
}, (table) => [
  index("idx_client_health_scores_account").on(table.orgId, table.clientAccountId),
  index("idx_client_health_scores_computed").on(table.orgId, table.computedAt),
]);

export const healthScoreConfigRelations = relations(healthScoreConfig, ({ one }) => ({
  organization: one(organizations, { fields: [healthScoreConfig.orgId], references: [organizations.id] }),
}));

export const clientHealthScoresRelations = relations(clientHealthScores, ({ one }) => ({
  organization: one(organizations, { fields: [clientHealthScores.orgId], references: [organizations.id] }),
  clientAccount: one(clientAccounts, { fields: [clientHealthScores.clientAccountId], references: [clientAccounts.id] }),
}));
