import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../auth";

export const tenantAiCredits = pgTable("tenant_ai_credits", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull().unique(),
  balance: integer("balance").default(0).notNull(),
  monthlyAllowance: integer("monthly_allowance").default(0).notNull(),
  lastResetAt: timestamp("last_reset_at"),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export const tenantAiCreditTransactions = pgTable(
  "tenant_ai_credit_transactions",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    delta: integer("delta").notNull(),
    balanceAfter: integer("balance_after").notNull(),
    reason: text("reason").notNull(),
    feature: text("feature"),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_tenant_ai_credit_txns_org_time").on(table.orgId, table.createdAt),
  ],
);

export const tenantAiCreditsRelations = relations(tenantAiCredits, ({ one }) => ({
  organization: one(organizations, { fields: [tenantAiCredits.orgId], references: [organizations.id] }),
}));
