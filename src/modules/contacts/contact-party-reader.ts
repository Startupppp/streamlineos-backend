import { eq, isNull, sql, type SQL } from "drizzle-orm";
import { businessParties, contactPartyMap } from "../../db/schema/party";

/**
 * Where this module's reads get their contacts.
 *
 * Ticket 02 made Party canonical and `contacts` a mirror derived from it, so a
 * `SELECT ... FROM contacts` is a read of a copy. Every field a screen renders —
 * name, email, phone, job title, employer, tags — comes from `business_parties`
 * here, and `contact_party_map` supplies the numeric id that URLs, vCards and
 * CSV columns still speak.
 *
 * **What `contacts` still owns.** Three columns on the legacy row are
 * associations with no Party equivalent yet:
 * `organization_id` points at `crm_organizations`, `lead_id` at `leads` and
 * `deal_id` at a deal. A party's employer should be another party, and nothing
 * gives `crm_organizations` parties to point at — ticket 01 left that gap open
 * and `party-mirror-fields.ts` records it as legacy-owned. So the association
 * ids are read from `contacts` and nothing else is: ids, never names. The same
 * arrangement `crm-customer360-sections.service.ts` arrived at from the other
 * direction, and the reason ticket 08 cannot drop `contacts` until employers
 * converge. Those columns are joined in at the two call sites that need them
 * rather than named here, so this file imports no legacy table and the
 * migration's reader count falls by what this batch migrated instead of gaining
 * a file.
 *
 * The tenant is asserted on the map row *and* carried across the join, so a
 * party in another organisation is unreachable even if a map row's `party_id`
 * were tampered with.
 *
 * The column names stay the ones `contacts` used, because the DTOs, the CSV
 * header and `buildVcard` all speak that vocabulary.
 *
 * **What makes a party a contact is a role, not a table.** `party_roles` carries
 * CONTACT, written by `party-legacy-contacts.ts` on every create and adopt, and
 * that is what tells a contact from a client once both tables are gone. The map
 * is matched on here only because it still carries the numeric id every URL and
 * vCard emits; ticket 08 drops it and leaves the role.
 */

/**
 * Party columns under the names `contacts` gave them.
 *
 * `twitterUrl` is the one that is not a column on either side: Party keeps every
 * social profile in one jsonb bag, because a column per network ages badly — the
 * one we have is named after a site that renamed itself — and the mirror unpacks
 * the single key `contacts` has a column for. Same expression the mirror's
 * `derive` uses, in SQL because a projection cannot call it.
 */
export const CONTACT_PARTY_COLUMNS = {
  id: contactPartyMap.contactId,
  partyId: businessParties.partyId,
  orgId: businessParties.organizationId,
  name: businessParties.name,
  email: businessParties.email,
  phone: businessParties.phone,
  title: businessParties.jobTitle,
  department: businessParties.department,
  company: businessParties.companyName,
  avatarUrl: businessParties.avatarUrl,
  linkedinUrl: businessParties.linkedinUrl,
  twitterUrl: sql<string | null>`${businessParties.socialProfiles} ->> 'twitter'`,
  websiteUrl: businessParties.website,
  tags: businessParties.tags,
  deletedAt: businessParties.deletedAt,
  createdAt: businessParties.createdAt,
  updatedAt: businessParties.updatedAt,
} as const;

/**
 * The join every contact read starts from.
 *
 * One SQL fragment rather than `and(...)` so it is a `SQL` and not a
 * `SQL | undefined` each call site would have to assert away.
 */
export const CONTACT_PARTY_JOIN: SQL = sql`${businessParties.partyId} = ${contactPartyMap.partyId} and ${businessParties.organizationId} = ${contactPartyMap.organizationId}`;

/**
 * Tenant scope for a contact read.
 *
 * Both sides of the join carry the predicate. The join already forces them
 * equal, so the second `eq` adds no rows — it adds the index.
 *
 * The soft delete now comes from Party rather than from `contacts.deleted_at`,
 * and the two agree because the mirror writes both in one transaction. Party is
 * the one that stays true after ticket 08.
 */
export function contactPartyScope(orgId: string): SQL[] {
  return [
    eq(contactPartyMap.organizationId, orgId),
    eq(businessParties.organizationId, orgId),
    isNull(businessParties.deletedAt),
  ];
}

/** One contact, by the numeric id everything outside Party still holds. */
export function contactIdIs(contactId: number): SQL {
  return eq(contactPartyMap.contactId, contactId);
}
