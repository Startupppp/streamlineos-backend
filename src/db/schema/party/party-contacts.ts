import {
  pgTable,
  text,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import { organizations } from "../auth";
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
    partyId: text("party_id")
      .references(() => businessParties.partyId, { onDelete: "cascade" })
      .notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name"),
    email: text("email"),
    phone: text("phone"),
    title: text("title"),
    isPrimary: boolean("is_primary").default(false).notNull(),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_party_contacts_org_contact").on(
      table.organizationId,
      table.partyContactId,
    ),
    index("idx_party_contacts_org_party").on(
      table.organizationId,
      table.partyId,
    ),
  ],
);
