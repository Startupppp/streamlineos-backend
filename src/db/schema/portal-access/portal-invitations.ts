import {
  pgTable,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { organizations, organizationMembers } from "../common/auth";
import { partyContacts } from "../party/party-contacts";
import { portalAudienceEnum, portalInvitationStatusEnum } from "../common/enums";
import { portalMemberships } from "./portal-memberships";

export const portalInvitations = pgTable(
  "portal_invitations",
  {
    portalInvitationId: text("portal_invitation_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    partyContactId: text("party_contact_id").notNull(),
    audience: portalAudienceEnum("audience").notNull().default("CLIENT_PORTAL"),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull(),
    status: portalInvitationStatusEnum("status").notNull().default("PENDING"),
    inviterMembershipId: integer("inviter_membership_id"),
    acceptedPortalMembershipId: text("accepted_portal_membership_id"),
    expiresAt: timestamp("expires_at").notNull(),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_portal_invitations_org_email_audience_pending")
      .on(table.organizationId, table.email, table.audience)
      .where(sql`status = 'PENDING'`),
    index("idx_portal_invitations_org_status").on(
      table.organizationId,
      table.status,
    ),
    foreignKey({
      columns: [table.organizationId, table.partyContactId],
      foreignColumns: [
        partyContacts.organizationId,
        partyContacts.partyContactId,
      ],
      name: "fk_portal_invitations_org_contact",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.acceptedPortalMembershipId],
      foreignColumns: [
        portalMemberships.organizationId,
        portalMemberships.portalMembershipId,
      ],
      name: "fk_portal_invitations_org_accepted_membership",
    }).onDelete("no action"),
    foreignKey({
      columns: [table.organizationId, table.inviterMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_portal_invitations_inviter_membership_id_org",
    }).onDelete("set null"),
  ],
);
