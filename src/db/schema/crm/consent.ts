import { pgTable, text, timestamp, integer, index, uniqueIndex, uuid, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import {
  crmConsentChannelEnum,
  crmConsentSourceEnum,
  crmConsentStatusEnum,
  crmLegalBasisEnum,
} from "../common/enums";
import { contacts } from "./contacts";

export const crmContactChannelConsent = pgTable("crm_contact_channel_consent", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  contactId: integer("contact_id").references(() => contacts.id, { onDelete: "cascade" }).notNull(),
  channel: crmConsentChannelEnum("channel").notNull(),
  status: crmConsentStatusEnum("status").default("UNKNOWN").notNull(),
  legalBasis: crmLegalBasisEnum("legal_basis"),
  source: crmConsentSourceEnum("source").default("USER_ENTRY").notNull(),
  sourceDetail: text("source_detail"),
  capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  recordedByUserId: text("recorded_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_crm_consent_org_contact").on(table.orgId, table.contactId),
  index("idx_crm_consent_org_channel_status").on(table.orgId, table.channel, table.status),
  uniqueIndex("uniq_crm_consent_org_contact_channel").on(table.orgId, table.contactId, table.channel),
  unique("uniq_crm_consent_org_id").on(table.orgId, table.id),
]);

/**
 * Append-only history. The row in `crm_contact_channel_consent` is current
 * state; every transition is also written here so a past decision is never
 * rewritten and an audit can prove what was true at send time.
 */
export const crmContactConsentEvents = pgTable("crm_contact_consent_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  contactId: integer("contact_id").references(() => contacts.id, { onDelete: "cascade" }).notNull(),
  channel: crmConsentChannelEnum("channel").notNull(),
  fromStatus: crmConsentStatusEnum("from_status"),
  toStatus: crmConsentStatusEnum("to_status").notNull(),
  legalBasis: crmLegalBasisEnum("legal_basis"),
  source: crmConsentSourceEnum("source").notNull(),
  sourceDetail: text("source_detail"),
  recordedByUserId: text("recorded_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_crm_consent_events_org_contact").on(table.orgId, table.contactId, table.createdAt),
  index("idx_crm_consent_events_org_created").on(table.orgId, table.createdAt),
  unique("uniq_crm_consent_events_org_id").on(table.orgId, table.id),
]);

export const crmContactChannelConsentRelations = relations(crmContactChannelConsent, ({ one }) => ({
  contact: one(contacts, { fields: [crmContactChannelConsent.contactId], references: [contacts.id] }),
  organization: one(organizations, { fields: [crmContactChannelConsent.orgId], references: [organizations.id] }),
  recordedBy: one(users, {
    fields: [crmContactChannelConsent.recordedByUserId],
    references: [users.id],
  }),
}));

export const crmContactConsentEventsRelations = relations(crmContactConsentEvents, ({ one }) => ({
  contact: one(contacts, { fields: [crmContactConsentEvents.contactId], references: [contacts.id] }),
  organization: one(organizations, { fields: [crmContactConsentEvents.orgId], references: [organizations.id] }),
}));
