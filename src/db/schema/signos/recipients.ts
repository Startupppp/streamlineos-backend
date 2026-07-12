import { pgTable, serial, text, integer, boolean, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../auth";
import { signRecipientStatusEnum, signRecipientTypeEnum, signAuthMethodEnum } from "./enums";
import { signEnvelopes } from "./envelopes";

export const signRecipients = pgTable(
  "sign_recipients",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    envelopeId: integer("envelope_id").references(() => signEnvelopes.id, { onDelete: "cascade" }).notNull(),
    roleName: text("role_name").notNull(),
    recipientType: signRecipientTypeEnum("recipient_type").default("signer").notNull(),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    routingOrder: integer("routing_order").default(1).notNull(),
    status: signRecipientStatusEnum("status").default("pending").notNull(),

    authMethod: signAuthMethodEnum("auth_method").default("email_link").notNull(),
    accessCodeHash: text("access_code_hash"),
    otpCodeHash: text("otp_code_hash"),
    otpExpiresAt: timestamp("otp_expires_at"),
    otpAttempts: integer("otp_attempts").default(0).notNull(),
    failedAuthAttempts: integer("failed_auth_attempts").default(0).notNull(),
    authLockedUntil: timestamp("auth_locked_until"),

    // The raw token is only ever shown once in the signing URL; we persist a hash to validate it later.
    signingTokenHash: text("signing_token_hash"),
    tokenExpiresAt: timestamp("token_expires_at"),
    tokenRevokedAt: timestamp("token_revoked_at"),

    consentAcceptedAt: timestamp("consent_accepted_at"),
    consentIp: text("consent_ip"),
    consentUserAgent: text("consent_user_agent"),
    consentDisclosureVersion: text("consent_disclosure_version"),

    delegatedToRecipientId: integer("delegated_to_recipient_id"),
    viewedAt: timestamp("viewed_at"),
    authenticatedAt: timestamp("authenticated_at"),
    completedAt: timestamp("completed_at"),
    declinedAt: timestamp("declined_at"),
    declinedReason: text("declined_reason"),
    bouncedAt: timestamp("bounced_at"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_sign_recipients_org_envelope").on(table.orgId, table.envelopeId),
    index("idx_sign_recipients_envelope_order").on(table.envelopeId, table.routingOrder),
    uniqueIndex("uniq_sign_recipients_token_hash").on(table.signingTokenHash),
  ],
);

export const signRecipientsRelations = relations(signRecipients, ({ one }) => ({
  organization: one(organizations, { fields: [signRecipients.orgId], references: [organizations.id] }),
  envelope: one(signEnvelopes, { fields: [signRecipients.envelopeId], references: [signEnvelopes.id] }),
  user: one(users, { fields: [signRecipients.userId], references: [users.id] }),
  delegatedTo: one(signRecipients, {
    fields: [signRecipients.delegatedToRecipientId],
    references: [signRecipients.id],
  }),
}));
