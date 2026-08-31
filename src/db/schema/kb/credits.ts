import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, organizationMembers } from "../common/auth";

export const tenantAiCredits = pgTable(
  "tenant_ai_credits",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull().unique(),
    balance: integer("balance").default(0).notNull(),
    monthlyAllowance: integer("monthly_allowance").default(0).notNull(),
    lastResetAt: timestamp("last_reset_at"),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    unique("uniq_tenant_ai_credits_org_id").on(table.orgId, table.id),
  ],
);

export const tenantAiCreditTransactions = pgTable(
  "tenant_ai_credit_transactions",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    delta: integer("delta").notNull(),
    balanceAfter: integer("balance_after").notNull(),
    reason: text("reason").notNull(),
    feature: text("feature"),
    actorMembershipId: integer("actor_membership_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_tenant_ai_credit_txns_org_time").on(table.orgId, table.createdAt),
    index("idx_tenant_ai_credit_txns_org_actor").on(table.orgId, table.actorMembershipId),
    unique("uniq_tenant_ai_credit_txns_org_id").on(table.orgId, table.id),
    foreignKey({ columns: [table.orgId, table.actorMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_tenant_ai_credit_txns_org_actor_membership" }).onDelete("set null"),
  ],
);

export const tenantAiCreditsRelations = relations(tenantAiCredits, ({ one }) => ({
  organization: one(organizations, { fields: [tenantAiCredits.orgId], references: [organizations.id] }),
}));

export const tenantAiCreditTransactionsRelations = relations(tenantAiCreditTransactions, ({ one }) => ({
  organization: one(organizations, { fields: [tenantAiCreditTransactions.orgId], references: [organizations.id] }),
  actorMembership: one(organizationMembers, { fields: [tenantAiCreditTransactions.actorMembershipId], references: [organizationMembers.id] }),
}));
