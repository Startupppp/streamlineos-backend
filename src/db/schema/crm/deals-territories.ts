import {
  pgTable,
  text,
  serial,
  timestamp,
  boolean,
  jsonb,
  integer,
  index,
  uniqueIndex,
  foreignKey,
  unique,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { orgUnits } from "../common/organization";
import { leads } from "./leads";
import { crmPeople } from "./analytics";
import { crmSla } from "./sla";

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
    createdByMembershipId: integer("created_by_membership_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
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
    foreignKey({
      columns: [table.orgId, table.territoryId],
      foreignColumns: [territories.orgId, territories.id],
    }).onDelete("cascade"),
  ],
);

export const crmSlaBreachLog = pgTable(
  "crm_sla_breach_log",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").notNull(),
    leadId: integer("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    policyId: integer("policy_id").references(() => crmSla.id, {
      onDelete: "set null",
    }),
    breachedAt: timestamp("breached_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    taskCreated: boolean("task_created").default(false).notNull(),
    notified: boolean("notified").default(false).notNull(),
  },
  (table) => [
    uniqueIndex("crm_sla_breach_log_lead_policy_unique").on(
      table.leadId,
      table.policyId,
    ),
  ],
);

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
