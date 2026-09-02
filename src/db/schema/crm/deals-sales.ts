import { boolean, date, decimal, foreignKey, index, integer, jsonb, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { incentiveStatusEnum } from "../common/enums";
import { organizations, users } from "../common/auth";
import { orgUnits } from "../common/organization";
import { clientAccounts } from "./contacts";
import { deals } from "./deals";

export const salesQuotas = pgTable(
  "sales_quotas",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    userMembershipId: integer("user_membership_id"),
    period: text("period").default("monthly").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    targetRevenue: decimal("target_revenue", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    actualRevenue: decimal("actual_revenue", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    notes: text("notes"),
    setById: text("set_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    setByMembershipId: integer("set_by_membership_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_sales_quotas_org_user").on(table.orgId, table.userId),
    unique("uniq_sales_quotas_org_id").on(table.orgId, table.id),
  ],
);

export const commissionRules = pgTable(
  "commission_rules",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    type: text("type").default("flat_percent").notNull(),
    flatRate: decimal("flat_rate", { precision: 5, scale: 2 }),
    tiers:
      jsonb("tiers").$type<
        Array<{ minValue: number; maxValue?: number | null; rate: number }>
      >(),
    appliesTo: text("applies_to").default("all").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [unique("uniq_commission_rules_org_id").on(t.orgId, t.id)],
);

export const commissions = pgTable(
  "commissions",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    userMembershipId: integer("user_membership_id"),
    dealId: integer("deal_id")
      .references(() => deals.id, { onDelete: "cascade" })
      .notNull(),
    ruleId: integer("rule_id").references(() => commissionRules.id, {
      onDelete: "set null",
    }),
    dealValue: decimal("deal_value", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    commissionRate: decimal("commission_rate", { precision: 5, scale: 2 })
      .default("0")
      .notNull(),
    commissionAmount: decimal("commission_amount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    status: text("status").default("pending").notNull(),
    paidAt: timestamp("paid_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_commissions_org_user").on(table.orgId, table.userId),
    index("idx_commissions_deal").on(table.dealId),
    unique("uniq_commissions_org_id").on(table.orgId, table.id),
  ],
);

export const incentiveConfig = pgTable(
  "incentive_config",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    branchId: text("branch_id"),
    incentiveRate: decimal("incentive_rate", {
      precision: 5,
      scale: 2,
    }).notNull(),
    effectiveFrom: timestamp("effective_from").defaultNow().notNull(),
    effectiveTo: timestamp("effective_to"),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdByMembershipId: integer("created_by_membership_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
  foreignKey({ columns: [t.orgId, t.branchId], foreignColumns: [orgUnits.orgId, orgUnits.id], name: "fk_incentive_config_branch_id_org" }).onDelete("set null"),unique("uniq_incentive_config_org_id").on(t.orgId, t.id)],
);

export const incentives = pgTable(
  "incentives",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    branchId: text("branch_id"),
    clientAccountId: integer("client_account_id")
      .notNull()
      .references(() => clientAccounts.id),
    salesRepId: text("sales_rep_id")
      .notNull()
      .references(() => users.id),
    salesRepMembershipId: integer("sales_rep_membership_id"),
    investmentAmount: decimal("investment_amount", {
      precision: 15,
      scale: 2,
    }).notNull(),
    incentiveRate: decimal("incentive_rate", {
      precision: 5,
      scale: 2,
    }).notNull(),
    calculatedAmount: decimal("calculated_amount", {
      precision: 15,
      scale: 2,
    }).notNull(),
    approvedAmount: decimal("approved_amount", { precision: 15, scale: 2 }),
    status: incentiveStatusEnum("status").notNull().default("PENDING"),
    approvedBy: text("approved_by").references(() => users.id),
    approvedByMembershipId: integer("approved_by_membership_id"),
    approvedAt: timestamp("approved_at"),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.branchId], foreignColumns: [orgUnits.orgId, orgUnits.id], name: "fk_incentives_branch_id_org" }).onDelete("set null"),
    index("idx_incentives_org").on(table.orgId),
    index("idx_incentives_sales_rep").on(table.salesRepId),
    index("idx_incentives_status").on(table.status),
    unique("uniq_incentives_org_id").on(table.orgId, table.id),
  ],
);

export const incentivesRelations = relations(incentives, ({ one }) => ({
  organization: one(organizations, {
    fields: [incentives.orgId],
    references: [organizations.id],
  }),
  clientAccount: one(clientAccounts, {
    fields: [incentives.clientAccountId],
    references: [clientAccounts.id],
  }),
  salesRep: one(users, {
    fields: [incentives.salesRepId],
    references: [users.id],
  }),
  approver: one(users, {
    fields: [incentives.approvedBy],
    references: [users.id],
  }),
}));
