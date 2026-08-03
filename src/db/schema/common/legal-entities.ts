import {
  pgTable,
  text,
  date,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  unique,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql, relations } from "drizzle-orm";
import { organizations, users } from "./auth";
import { orgUnits } from "./organization";

export const legalEntities = pgTable(
  "legal_entities",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),

    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    name: text("name").notNull(),
    legalName: text("legal_name").notNull(),

    countryCode: text("country_code").notNull().default("IN"),
    stateCode: text("state_code"),
    functionalCurrency: text("functional_currency").notNull().default("INR"),

    gstin: text("gstin"),
    pan: text("pan"),
    tan: text("tan"),
    pfEstablishmentCode: text("pf_establishment_code"),
    esiCode: text("esi_code"),
    ptRegistrationNumber: text("pt_registration_number"),
    lwfCode: text("lwf_code"),
    cin: text("cin"),
    llpin: text("llpin"),
    udyamNumber: text("udyam_number"),

    registeredAddress: jsonb("registered_address").$type<{
      line1?: string;
      line2?: string;
      city?: string;
      state?: string;
      country?: string;
      postalCode?: string;
    }>(),

    dataResidencyRegion: text("data_residency_region"),

    invoicePrefix: text("invoice_prefix").notNull().default("INV"),
    invoiceFyReset: boolean("invoice_fy_reset").notNull().default(true),
    invoiceSeries: text("invoice_series").notNull().default("DEFAULT"),

    status: text("status").notNull().default("ACTIVE"),

    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to")
      .notNull()
      .default(sql`'infinity'::date`),

    parentLegalEntityId: text("parent_legal_entity_id").references(
      (): AnyPgColumn => legalEntities.id,
      { onDelete: "set null" },
    ),

    orgUnitId: text("org_unit_id").references(() => orgUnits.id, {
      onDelete: "set null",
    }),

    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    unique("uniq_legal_entities_org_id").on(table.orgId, table.id),
    index("idx_legal_entities_org_status").on(table.orgId, table.status),
    index("idx_legal_entities_org_country").on(table.orgId, table.countryCode),
    uniqueIndex("uniq_legal_entities_org_gstin")
      .on(table.orgId, table.gstin)
      .where(sql`gstin IS NOT NULL`),
    uniqueIndex("uniq_legal_entities_org_pan")
      .on(table.orgId, table.pan)
      .where(sql`pan IS NOT NULL`),
  ],
);

export const legalEntitiesRelations = relations(legalEntities, ({ one, many }) => ({
  org: one(organizations, {
    fields: [legalEntities.orgId],
    references: [organizations.id],
  }),
  parent: one(legalEntities, {
    fields: [legalEntities.parentLegalEntityId],
    references: [legalEntities.id],
    relationName: "legal_entity_subsidiary",
  }),
  children: many(legalEntities, { relationName: "legal_entity_subsidiary" }),
  orgUnit: one(orgUnits, {
    fields: [legalEntities.orgUnitId],
    references: [orgUnits.id],
  }),
  createdByUser: one(users, {
    fields: [legalEntities.createdBy],
    references: [users.id],
  }),
}));
