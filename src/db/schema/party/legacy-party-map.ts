import {
  pgTable,
  text,
  integer,
  timestamp,
  index,
  primaryKey,
  foreignKey,
} from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";
import { businessParties } from "./business-parties";
import { leads } from "../crm/leads";
import { clients, contacts, crmOrganizations } from "../crm/contacts";

/**
 * Which Party a legacy identifier means.
 *
 * The same customer exists as a lead, a client, a contact and a party, and for
 * the length of the expand–contract migration every one of those identifiers is
 * still held by something — a URL a user bookmarked, a row in `deals`, a job
 * argument already on the queue. These tables are how any of them finds the
 * Party.
 *
 * A real table, and one per legacy kind rather than one polymorphic
 * `(kind, id)` table. The polymorphic shape is banned for new tables here for
 * the reason it matters most in exactly this case: it carries no referential
 * integrity, so nothing stops a row pointing at a lead that no longer exists,
 * and a resolution that quietly returns the wrong person is worse than one that
 * fails. With a real composite foreign key, deleting the legacy row takes the
 * mapping with it and the resolver simply misses. The polymorphism lives in
 * TypeScript, in `party-legacy-seam.ts`, where it is checked.
 *
 * Not unique on `party_id`: after a merge, several legacy identifiers
 * legitimately answer to one surviving Party. That is the point of it.
 *
 * `business_parties` itself needs no table here — a party id resolves to itself.
 */

export const leadPartyMap = pgTable(
  "lead_party_map",
  {
    organizationId: text("organization_id").notNull(),
    leadId: integer("lead_id").notNull(),
    partyId: text("party_id").notNull(),
    /** `migration:0241` for the backfill, a user id when someone re-pointed it. */
    linkedBy: text("linked_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.leadId], name: "pk_lead_party_map" }),
    // The reverse read: which legacy ids this party answers to. The merge needs
    // it to re-point them, and it is how a Party surface can still show the
    // legacy record it came from.
    index("idx_lead_party_map_party").on(t.organizationId, t.partyId),
    foreignKey({
      columns: [t.organizationId],
      foreignColumns: [organizations.id],
      name: "fk_lead_party_map_org",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.organizationId, t.leadId],
      foreignColumns: [leads.orgId, leads.id],
      name: "fk_lead_party_map_lead",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.organizationId, t.partyId],
      foreignColumns: [businessParties.organizationId, businessParties.partyId],
      name: "fk_lead_party_map_party",
    }).onDelete("cascade"),
  ],
);

export const clientPartyMap = pgTable(
  "client_party_map",
  {
    organizationId: text("organization_id").notNull(),
    clientId: integer("client_id").notNull(),
    partyId: text("party_id").notNull(),
    linkedBy: text("linked_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.clientId], name: "pk_client_party_map" }),
    index("idx_client_party_map_party").on(t.organizationId, t.partyId),
    foreignKey({
      columns: [t.organizationId],
      foreignColumns: [organizations.id],
      name: "fk_client_party_map_org",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.organizationId, t.clientId],
      foreignColumns: [clients.orgId, clients.id],
      name: "fk_client_party_map_client",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.organizationId, t.partyId],
      foreignColumns: [businessParties.organizationId, businessParties.partyId],
      name: "fk_client_party_map_party",
    }).onDelete("cascade"),
  ],
);

export const contactPartyMap = pgTable(
  "contact_party_map",
  {
    organizationId: text("organization_id").notNull(),
    contactId: integer("contact_id").notNull(),
    partyId: text("party_id").notNull(),
    linkedBy: text("linked_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.contactId], name: "pk_contact_party_map" }),
    index("idx_contact_party_map_party").on(t.organizationId, t.partyId),
    foreignKey({
      columns: [t.organizationId],
      foreignColumns: [organizations.id],
      name: "fk_contact_party_map_org",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.organizationId, t.contactId],
      foreignColumns: [contacts.orgId, contacts.id],
      name: "fk_contact_party_map_contact",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.organizationId, t.partyId],
      foreignColumns: [businessParties.organizationId, businessParties.partyId],
      name: "fk_contact_party_map_party",
    }).onDelete("cascade"),
  ],
);

/**
 * The fourth map, and the one that arrived late.
 *
 * The phase treated `contacts`, `clients`, `leads` and `business_parties` as the
 * identity split; it was five tables. `crm_organizations` is a company record
 * with a name, a domain, an industry, a health score, a parent pointer and its
 * own merge service — Party, built again, with its own duplicate handling. Ticket
 * 25 converged it, and this is how a `crm_organizations` id bookmarked in a URL,
 * stored on a `feedbucket_submissions` row or held by `roadmap_items` still finds
 * the party it became.
 *
 * `crm_org_party_map`, not `organization_party_map`: `organizations` is the
 * tenant table, and a map called `organization_party_map` would read as tenants
 * mapping to parties. The `crm_org` prefix is already the codebase's shorthand
 * for this table.
 */
export const crmOrgPartyMap = pgTable(
  "crm_org_party_map",
  {
    organizationId: text("organization_id").notNull(),
    crmOrganizationId: integer("crm_organization_id").notNull(),
    partyId: text("party_id").notNull(),
    /** `migration:0264` for the backfill, a user id when someone re-pointed it. */
    linkedBy: text("linked_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.organizationId, t.crmOrganizationId],
      name: "pk_crm_org_party_map",
    }),
    index("idx_crm_org_party_map_party").on(t.organizationId, t.partyId),
    foreignKey({
      columns: [t.organizationId],
      foreignColumns: [organizations.id],
      name: "fk_crm_org_party_map_org",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.organizationId, t.crmOrganizationId],
      foreignColumns: [crmOrganizations.orgId, crmOrganizations.id],
      name: "fk_crm_org_party_map_crm_org",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.organizationId, t.partyId],
      foreignColumns: [businessParties.organizationId, businessParties.partyId],
      name: "fk_crm_org_party_map_party",
    }).onDelete("cascade"),
  ],
);
