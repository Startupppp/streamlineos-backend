import { sql } from "drizzle-orm";
import { check, foreignKey, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { invitations } from "./auth";
import { outboxEvents } from "./outbox";

export const organizationSetupInvitationReceipts = pgTable(
  "organization_setup_invitation_receipts",
  {
    orgId: text("org_id").notNull(),
    producerEventId: text("producer_event_id").notNull(),
    canonicalEmail: text("canonical_email").notNull(),
    invitationId: text("invitation_id"),
    outcome: text("outcome").$type<"SKIPPED_SELF" | "REFUSED" | "QUEUED" | "DELIVERY_FAILED">().notNull(),
    reasonCode: text("reason_code").$type<"UNKNOWN" | "EMAIL_NOT_SENT">(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      name: "pk_organization_setup_invitation_receipts",
      columns: [table.orgId, table.producerEventId, table.canonicalEmail],
    }),
    foreignKey({
      name: "fk_organization_setup_invitation_receipts_event",
      columns: [table.orgId, table.producerEventId],
      foreignColumns: [outboxEvents.organizationId, outboxEvents.eventId],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_organization_setup_invitation_receipts_invitation",
      columns: [table.orgId, table.invitationId],
      foreignColumns: [invitations.orgId, invitations.id],
    }).onDelete("cascade"),
    check(
      "ck_organization_setup_invitation_receipts_email",
      sql`${table.canonicalEmail} = lower(btrim(${table.canonicalEmail})) AND ${table.canonicalEmail} <> ''`,
    ),
    check(
      "ck_organization_setup_invitation_receipts_outcome",
      sql`(${table.outcome} = 'SKIPPED_SELF' AND ${table.invitationId} IS NULL AND ${table.reasonCode} IS NULL)
        OR (${table.outcome} = 'REFUSED' AND ${table.invitationId} IS NULL AND ${table.reasonCode} = 'UNKNOWN')
        OR (${table.outcome} = 'QUEUED' AND ${table.invitationId} IS NOT NULL AND ${table.reasonCode} IS NULL)
        OR (${table.outcome} = 'DELIVERY_FAILED' AND ${table.invitationId} IS NOT NULL AND ${table.reasonCode} = 'EMAIL_NOT_SENT')`,
    ),
  ],
);
