import {
  pgTable,
  jsonb,
  text,
  boolean,
  timestamp,
  index,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import { organizations } from "../common/auth";
import { businessParties } from "./business-parties";

export const partyContacts = pgTable(
  "party_contacts",
  {
    partyContactId: text("party_contact_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    partyId: text("party_id").notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name"),
    email: text("email"),
    phone: text("phone"),
    title: text("title"),
    isPrimary: boolean("is_primary").default(false).notNull(),
    customFields: jsonb("custom_fields").$type<Record<string, unknown>>(),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("uniq_party_contacts_org_contact").on(
      table.organizationId,
      table.partyContactId,
    ),
    index("idx_party_contacts_org_party").on(
      table.organizationId,
      table.partyId,
    ),
    foreignKey({
      columns: [table.organizationId, table.partyId],
      foreignColumns: [businessParties.organizationId, businessParties.partyId],
      name: "fk_party_contacts_org_party",
    }).onDelete("cascade"),
  ],
);
