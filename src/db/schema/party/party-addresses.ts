import {
  pgTable,
  text,
  boolean,
  timestamp,
  index,
  foreignKey,
  unique,
} from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import { organizations } from "../common/auth";
import { businessParties } from "./business-parties";

export const partyAddresses = pgTable(
  "party_addresses",
  {
    partyAddressId: text("party_address_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    partyId: text("party_id").notNull(),
    addressType: text("address_type")
      .$type<"billing" | "shipping" | "other">()
      .notNull(),
    line1: text("line1").notNull(),
    line2: text("line2"),
    city: text("city"),
    state: text("state"),
    country: text("country"),
    postalCode: text("postal_code"),
    isPrimary: boolean("is_primary").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_party_addresses_org_party").on(
      table.organizationId,
      table.partyId,
    ),
    foreignKey({
      columns: [table.organizationId, table.partyId],
      foreignColumns: [businessParties.organizationId, businessParties.partyId],
      name: "fk_party_addresses_org_party",
    }).onDelete("cascade"),
    unique("uniq_party_addresses_org_id").on(table.organizationId, table.partyAddressId),
  ],
);
