import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { organizations, users } from "./auth";

export const accountOrganizationIndex = pgTable(
  "account_organization_index",
  {
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    cellId: text("cell_id").notNull(),
    region: text("region").notNull(),
    organizationName: text("organization_name").notNull(),
    organizationSlug: text("organization_slug").notNull(),
    membershipRole: text("membership_role").notNull(),
    membershipStatus: text("membership_status").notNull(),
    organizationStatus: text("organization_status").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }),
    projectedAt: timestamp("projected_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: "pk_account_organization_index",
      columns: [table.userId, table.orgId],
    }),
    index("idx_account_org_index_user").on(table.userId, table.membershipStatus),
    index("idx_account_org_index_org").on(table.orgId),
    index("idx_account_org_index_projected").on(table.projectedAt),
  ],
);
