import {
  pgTable,
  jsonb,
  text,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import { organizations } from "../common/auth";
import { partyTypeEnum } from "../common/enums";

export const businessParties = pgTable(
  "business_parties",
  {
    partyId: text("party_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    partyType: partyTypeEnum("party_type").notNull().default("CUSTOMER"),
    name: text("name").notNull(),
    legalName: text("legal_name"),
    displayName: text("display_name"),
    taxNumber: text("tax_number"),
    website: text("website"),
    email: text("email"),
    phone: text("phone"),
    status: text("status").default("active").notNull(),
    customFields: jsonb("custom_fields").$type<Record<string, unknown>>(),
    notes: text("notes"),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("uniq_business_parties_org_party").on(
      table.organizationId,
      table.partyId,
    ),
    index("idx_business_parties_org_type").on(
      table.organizationId,
      table.partyType,
    ),
  ],
);
