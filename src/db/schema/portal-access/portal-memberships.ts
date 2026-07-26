import {
  pgTable,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { organizations, users } from "../auth";
import {
  portalAudienceEnum,
  portalMembershipStatusEnum,
} from "../enums";

export const portalMemberships = pgTable(
  "portal_memberships",
  {
    portalMembershipId: text("portal_membership_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    audience: portalAudienceEnum("audience").notNull().default("CLIENT_PORTAL"),
    partyContactId: text("party_contact_id").notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    status: portalMembershipStatusEnum("status").notNull().default("PENDING"),
    sessionEpoch: integer("session_epoch").notNull().default(0),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_portal_memberships_org_membership").on(
      table.organizationId,
      table.portalMembershipId,
    ),
    uniqueIndex("uniq_portal_memberships_org_contact_audience")
      .on(table.organizationId, table.partyContactId, table.audience)
      .where(sql`status <> 'REVOKED'`),
    index("idx_portal_memberships_org_status").on(
      table.organizationId,
      table.status,
    ),
    index("idx_portal_memberships_user").on(table.userId),
  ],
);
