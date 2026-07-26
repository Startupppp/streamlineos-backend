import { pgTable, serial, text, integer, jsonb, timestamp, index, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../auth";
import { signActorTypeEnum, signAuditEventTypeEnum } from "./enums";
import { signEnvelopes } from "./envelopes";
import { signRecipients } from "./recipients";

// Append-only. No service in this module should ever UPDATE or DELETE a row here.
export const signAuditEvents = pgTable(
  "sign_audit_events",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    // Nullable: template/bulk-job/admin-setting events are tenant-scoped, not tied to one envelope.
    envelopeId: integer("envelope_id").references(() => signEnvelopes.id, { onDelete: "cascade" }),
    recipientId: integer("recipient_id").references(() => signRecipients.id, { onDelete: "set null" }),
    actorType: signActorTypeEnum("actor_type").notNull(),
    actorUserId: text("actor_user_id"),
    actorName: text("actor_name"),
    actorEmail: text("actor_email"),
    eventType: signAuditEventTypeEnum("event_type").notNull(),
    eventMessage: text("event_message"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    geolocationJson: jsonb("geolocation_json").$type<Record<string, unknown>>(),
    documentHash: text("document_hash"),
    requestId: text("request_id"),
    eventPayloadJson: jsonb("event_payload_json").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_sign_audit_events_org_envelope_created").on(table.orgId, table.envelopeId, table.createdAt),
    index("idx_sign_audit_events_recipient").on(table.recipientId),
    index("idx_sign_audit_events_type").on(table.eventType),
    unique("uniq_sign_audit_events_org_id").on(table.orgId, table.id),
  ],
);

export const signAuditEventsRelations = relations(signAuditEvents, ({ one }) => ({
  organization: one(organizations, { fields: [signAuditEvents.orgId], references: [organizations.id] }),
  envelope: one(signEnvelopes, { fields: [signAuditEvents.envelopeId], references: [signEnvelopes.id] }),
  recipient: one(signRecipients, { fields: [signAuditEvents.recipientId], references: [signRecipients.id] }),
}));
