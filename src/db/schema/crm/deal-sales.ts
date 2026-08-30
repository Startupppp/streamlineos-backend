import {
  pgTable,
  text,
  serial,
  timestamp,
  boolean,
  jsonb,
  decimal,
  date,
  integer,
  index,
  uniqueIndex,
  foreignKey,
  unique,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { incentiveStatusEnum } from "../common/enums";
import { organizations, users } from "../common/auth";
import { orgUnits } from "../common/organization";
import { clientAccounts } from "./contacts";
import { crmPeople } from "./analytics";
import { deals } from "./deal-pipeline";

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
    branchId: text("branch_id").references(() => orgUnits.id, { onDelete: "set null" }),
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
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [unique("uniq_incentive_config_org_id").on(t.orgId, t.id)],
);

export const incentives = pgTable(
  "incentives",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    branchId: text("branch_id").references(() => orgUnits.id, { onDelete: "set null" }),
    clientAccountId: integer("client_account_id")
      .notNull()
      .references(() => clientAccounts.id),
    salesRepId: text("sales_rep_id")
      .notNull()
      .references(() => users.id),
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
    approvedAt: timestamp("approved_at"),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_incentives_org").on(table.orgId),
    index("idx_incentives_sales_rep").on(table.salesRepId),
    index("idx_incentives_status").on(table.status),
    unique("uniq_incentives_org_id").on(table.orgId, table.id),
  ],
);

export interface TerritoryCriteria {
  countries?: string[];
  states?: string[];
  cities?: string[];
  postalCodes?: string[];
  industries?: string[];
  companySizes?: string[];
  productKeys?: string[];
  accountTypes?: string[];
}

export const territories = pgTable(
  "territories",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    description: text("description"),
    isActive: boolean("is_active").default(true).notNull(),
    criteria: jsonb("criteria")
      .$type<TerritoryCriteria>()
      .default({})
      .notNull(),
    priority: integer("priority").default(0).notNull(),
    createdBy: text("created_by").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    index("territories_org_id_idx").on(table.orgId),
    unique("uniq_territories_org_id").on(table.orgId, table.id),
    index("idx_territories_org_live")
      .on(table.orgId, table.priority)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export const territoryReps = pgTable(
  "territory_reps",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    territoryId: integer("territory_id").notNull(),
    crmPersonId: integer("crm_person_id")
      .references(() => crmPeople.id, { onDelete: "cascade" })
      .notNull(),
    assignedAt: timestamp("assigned_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uniq_territory_reps_territory_person").on(
      table.territoryId,
      table.crmPersonId,
    ),
    index("idx_territory_reps_org").on(table.orgId),
    index("idx_territory_reps_territory").on(table.territoryId),
    foreignKey({
      columns: [table.orgId, table.territoryId],
      foreignColumns: [territories.orgId, territories.id],
    }).onDelete("cascade"),
    unique("uniq_territory_reps_org_id").on(table.orgId, table.id),
  ],
);

export const territoryLocations = pgTable(
  "territory_locations",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    territoryId: integer("territory_id").notNull(),
    kind: text("kind").notNull(),
    value: text("value").notNull(),
  },
  (table) => [
    uniqueIndex("uniq_territory_locations_territory_kind_value").on(
      table.territoryId,
      table.kind,
      table.value,
    ),
    index("idx_territory_locations_org").on(table.orgId),
    index("idx_territory_locations_territory").on(table.territoryId),
    foreignKey({
      columns: [table.orgId, table.territoryId],
      foreignColumns: [territories.orgId, territories.id],
    }).onDelete("cascade"),
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

export const territoriesRelations = relations(territories, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [territories.orgId],
    references: [organizations.id],
  }),
  creator: one(users, {
    fields: [territories.createdBy],
    references: [users.id],
  }),
  reps: many(territoryReps),
  locations: many(territoryLocations),
}));

export const territoryRepsRelations = relations(territoryReps, ({ one }) => ({
  territory: one(territories, {
    fields: [territoryReps.orgId, territoryReps.territoryId],
    references: [territories.orgId, territories.id],
  }),
  crmPerson: one(crmPeople, {
    fields: [territoryReps.crmPersonId],
    references: [crmPeople.id],
  }),
}));

export const territoryLocationsRelations = relations(
  territoryLocations,
  ({ one }) => ({
    territory: one(territories, {
      fields: [territoryLocations.orgId, territoryLocations.territoryId],
      references: [territories.orgId, territories.id],
    }),
  }),
);
