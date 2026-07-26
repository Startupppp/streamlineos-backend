import {
  pgTable,
  text,
  integer,
  decimal,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations, users } from "../auth";
import { businessParties } from "../party/business-parties";
import { leads } from "./leads";
import { crmOrganizations } from "./contacts";

export const crmPartyAccounts = pgTable(
  "crm_party_accounts",
  {
    crmAccountId: text("crm_account_id")
      .primaryKey()
      .references(() => businessParties.partyId, { onDelete: "cascade" }),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    leadId: integer("lead_id").references(() => leads.id, {
      onDelete: "set null",
    }),
    accountManagerId: text("account_manager_id").references(() => users.id, {
      onDelete: "set null",
    }),
    healthScore: integer("health_score").default(50).notNull(),
    healthStatus: text("health_status")
      .$type<"healthy" | "at_risk" | "critical">()
      .default("healthy")
      .notNull(),
    lastHealthCheck: timestamp("last_health_check"),
    churnRiskScore: integer("churn_risk_score"),
    churnRiskReasoning: text("churn_risk_reasoning"),
    investmentValue: decimal("investment_value", { precision: 15, scale: 2 }),
    convertedAt: timestamp("converted_at"),
    crmOrganizationId: integer("crm_organization_id").references(
      () => crmOrganizations.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_crm_party_accounts_org_party").on(
      table.orgId,
      table.crmAccountId,
    ),
    index("idx_crm_party_accounts_account_manager").on(table.accountManagerId),
    index("idx_crm_party_accounts_org_health").on(
      table.orgId,
      table.healthStatus,
    ),
  ],
);
