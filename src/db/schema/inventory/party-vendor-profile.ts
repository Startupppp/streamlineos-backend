import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations, users } from "../common/auth";
import { businessParties } from "../party/business-parties";

export const invPartyVendorProfiles = pgTable(
  "inv_party_vendor_profiles",
  {
    vendorProfileId: text("vendor_profile_id")
      .primaryKey()
      .references(() => businessParties.partyId, { onDelete: "cascade" }),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    vendorCode: text("vendor_code").notNull(),
    leadTimeDays: integer("lead_time_days").default(7).notNull(),
    paymentTermsDays: integer("payment_terms_days").default(30).notNull(),
    currency: text("currency").default("INR").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    notes: text("notes"),
    createdBy: text("created_by")
      .references(() => users.id)
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_inv_vendor_profile_org_code").on(
      table.orgId,
      table.vendorCode,
    ),
    index("idx_inv_vendor_profile_org").on(table.orgId),
  ],
);
