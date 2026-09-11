import { and, eq, inArray, sql } from "drizzle-orm";
import {
  clientPartyMap,
  contactPartyMap,
  crmOrgPartyMap,
  leadPartyMap,
} from "../../db/schema/party";
import { clients, contacts, crmOrganizations } from "../../db/schema/crm/contacts";
import { leads } from "../../db/schema/crm/leads";
import {
  CLIENT_MIRROR,
  CONTACT_MIRROR,
  LEAD_MIRROR,
  ORGANISATION_MIRROR,
  type PartyPatch,
  type PartyRow,
} from "./party-legacy-mirror";
import type { MappedLegacyKind } from "./party-legacy-seam";
import { applyPartyPatch, loadParty, type MirrorDb } from "./party-write-primitives";
import { employerLegacyIds } from "./party-legacy-employer";
import { convertedFromColumnOf, parentColumnOf } from "./party-legacy-associations";

/**
 * The shared half of the Party-first write, and the Party surface itself.
 *
 * Party is canonical from this ticket onward. That is a decision, not a
 * mechanism: legacy tables keep taking writes so unmigrated modules keep
 * working, but nothing reads them as truth again, which turns a disagreement
 * from "two sources, pick one" into "the mirror is stale". Every function here
 * writes the Party row first and the legacy row second inside one transaction,
 * and the legacy values always come out of `party-legacy-mirror`'s single
 * derivation rather than being assembled a second time.
 *
 * The three legacy entry points live beside this file, one per kind, because
 * each carries its own map table, its own adoption path and its own `$inferInsert`
 * — and because a single file holding all three was past the size at which
 * anybody reads the one they need. What they share is here.
 *
 * Plain functions taking `db`, matching `party-legacy-seam.ts` rather than
 * introducing a service. Forty-odd call sites live in a dozen modules; making
 * this injectable would add a constructor parameter to every one of their
 * services and to every spec that builds one by hand, for no behaviour.
 *
 * `db.transaction` inside a request opens a SAVEPOINT, because `this.db` is the
 * tenant-aware proxy and already resolves to the request's transaction. That is
 * exactly what is wanted here — the Party and its mirror commit or roll back
 * together, without a second connection and without escaping the tenant GUC.
 * Callers that hold their own `tx` pass it instead, and the savepoint nests.
 */

/**
 * Re-exported so every module importing these from here is untouched by the
 * split, and so this file stays the one Party-write surface to import.
 *
 * `loadParty` and `loadParties` are deliberately NOT re-exported: they were
 * module-private before the split and stay that way from the outside. They
 * carry `export` next door only because this file needs them.
 */
export {
  applyPartyPatch,
  grantRole,
  groupByPayload,
  insertBareParty,
  mintLegacyId,
  movePartiesFor,
  type MirrorDb,
  type MirrorWriteOptions,
} from "./party-write-primitives";

export type LeadRow = typeof leads.$inferSelect;
export type ClientRow = typeof clients.$inferSelect;
export type ContactRow = typeof contacts.$inferSelect;
export type LeadInsert = typeof leads.$inferInsert;
export type ClientInsert = typeof clients.$inferInsert;
export type ContactInsert = typeof contacts.$inferInsert;
export type CrmOrgRow = typeof crmOrganizations.$inferSelect;
export type CrmOrgInsert = typeof crmOrganizations.$inferInsert;

// --- The Party surface ------------------------------------------------------

/**
 * Pushes a Party row out to every legacy row that mirrors it.
 *
 * Every legacy row, plural: a merge re-points the losing record's map row onto
 * the survivor, so one Party legitimately answers for several legacy
 * identifiers, and refreshing only one of them would leave the others as the
 * stale copies this whole ticket exists to rule out.
 */
async function refreshMirrorsOfParty(
  db: MirrorDb,
  organizationId: string,
  party: PartyRow,
): Promise<void> {
  const [leadRows, clientRows, contactRows, orgRows] = await Promise.all([
    db
      .select({ id: leadPartyMap.leadId })
      .from(leadPartyMap)
      .where(
        and(
          eq(leadPartyMap.organizationId, organizationId),
          eq(leadPartyMap.partyId, party.partyId),
        ),
      ),
    db
      .select({ id: clientPartyMap.clientId })
      .from(clientPartyMap)
      .where(
        and(
          eq(clientPartyMap.organizationId, organizationId),
          eq(clientPartyMap.partyId, party.partyId),
        ),
      ),
    db
      .select({ id: contactPartyMap.contactId })
      .from(contactPartyMap)
      .where(
        and(
          eq(contactPartyMap.organizationId, organizationId),
          eq(contactPartyMap.partyId, party.partyId),
        ),
      ),
    db
      .select({ id: crmOrgPartyMap.crmOrganizationId })
      .from(crmOrgPartyMap)
      .where(
        and(
          eq(crmOrgPartyMap.organizationId, organizationId),
          eq(crmOrgPartyMap.partyId, party.partyId),
        ),
      ),
  ]);

  const leadIds = leadRows.map((row) => row.id);
  if (leadIds.length > 0)
    await db
      .update(leads)
      .set(LEAD_MIRROR.derive(party))
      .where(and(eq(leads.orgId, organizationId), inArray(leads.id, leadIds)));

  const clientIds = clientRows.map((row) => row.id);
  if (clientIds.length > 0)
    await db
      .update(clients)
      .set({
        ...CLIENT_MIRROR.derive(party),
        // Outside the pure derivation because it crosses id spaces; see
        // `party-legacy-associations.ts`. Without it, re-pointing a client at a
        // different lead on the Party surface would leave `clients.lead_id` on
        // the old one indefinitely.
        ...(await convertedFromColumnOf(db, organizationId, party.convertedFromPartyId)),
      })
      .where(and(eq(clients.orgId, organizationId), inArray(clients.id, clientIds)));

  const contactIds = contactRows.map((row) => row.id);
  if (contactIds.length > 0)
    await db
      .update(contacts)
      .set({
        ...CONTACT_MIRROR.derive(party),
        // Outside the pure derivation because they cross id spaces; see
        // `party-legacy-employer.ts` and `party-legacy-associations.ts`. Without
        // them, moving somebody to a new employer or a new source lead on the
        // Party surface would leave the legacy columns pointing at the old ones
        // indefinitely.
        ...(await employerColumnOf(db, organizationId, party)),
        ...(await convertedFromColumnOf(db, organizationId, party.convertedFromPartyId)),
      })
      .where(and(eq(contacts.orgId, organizationId), inArray(contacts.id, contactIds)));

  const crmOrgIds = orgRows.map((row) => row.id);
  if (crmOrgIds.length > 0)
    await db
      .update(crmOrganizations)
      .set({
        ...ORGANISATION_MIRROR.derive(party),
        // The account hierarchy, which crosses id spaces the same way; see
        // `party-legacy-associations.ts`.
        ...(await parentColumnOf(db, organizationId, party.parentPartyId)),
      })
      .where(
        and(eq(crmOrganizations.orgId, organizationId), inArray(crmOrganizations.id, crmOrgIds)),
      );
}

/**
 * The `contacts.organization_id` this party's employer means, as a patch.
 *
 * A whole column rather than a conditional: a party with no employer must write
 * `null`, not nothing, or clearing an employer would silently leave the old one
 * on the legacy row — which is the exact shape of stale the mirror exists to
 * rule out.
 */
export async function employerColumnOf(
  db: MirrorDb,
  organizationId: string,
  party: PartyRow,
): Promise<{ organizationId: number | null }> {
  if (!party.employerPartyId) return { organizationId: null };
  const legacy = await employerLegacyIds(db, organizationId, [party.employerPartyId]);
  return { organizationId: legacy.get(party.employerPartyId) ?? null };
}

/**
 * Brings every legacy row mapped to a party back in line with it, changing
 * nothing on the party.
 *
 * The one caller is the merge: re-pointing the loser's `*_party_map` rows onto
 * the survivor hands the survivor legacy rows it has never derived, and those
 * rows still hold the loser's values until this runs.
 */
export async function refreshPartyMirrors(
  db: MirrorDb,
  organizationId: string,
  partyId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const party = await loadParty(tx, organizationId, partyId);
    if (!party) return;
    await refreshMirrorsOfParty(tx, organizationId, party);
  });
}

export async function updatePartyWithMirror(
  db: MirrorDb,
  organizationId: string,
  partyId: string,
  patch: PartyPatch,
): Promise<PartyRow> {
  return db.transaction(async (tx) => {
    const party = await applyPartyPatch(tx, organizationId, partyId, patch);
    await refreshMirrorsOfParty(tx, organizationId, party);
    return party;
  });
}

/**
 * Soft-deletes a Party and everything that mirrors it.
 *
 * `clients` has no `deleted_at`, so a client mirror cannot record the deletion.
 * That gap is reported by `findUnexpressibleDeletions` rather than closed by
 * inventing a meaning for `clients.status`: the legacy surface has never offered
 * a client delete, and giving it one here would be a behaviour change outside
 * this ticket's remit.
 */
export async function softDeletePartyWithMirror(
  db: MirrorDb,
  organizationId: string,
  partyId: string,
): Promise<PartyRow> {
  return updatePartyWithMirror(db, organizationId, partyId, { deletedAt: new Date() });
}

/** Undoes a soft delete on both sides, for the merge revert path. */
export async function restorePartyWithMirror(
  db: MirrorDb,
  organizationId: string,
  partyId: string,
  patch: PartyPatch = {},
): Promise<PartyRow> {
  return updatePartyWithMirror(db, organizationId, partyId, { ...patch, deletedAt: null });
}

/**
 * How many legacy rows currently disagree with their Party, per kind.
 *
 * Kept here rather than in the divergence service so that a test of the writer
 * can assert its own claim: after any function above, this is zero.
 */
export async function countMirroredRows(
  db: MirrorDb,
  organizationId: string,
): Promise<Record<MappedLegacyKind, number>> {
  const [lead] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(leadPartyMap)
    .where(eq(leadPartyMap.organizationId, organizationId));
  const [client] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(clientPartyMap)
    .where(eq(clientPartyMap.organizationId, organizationId));
  const [contact] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(contactPartyMap)
    .where(eq(contactPartyMap.organizationId, organizationId));
  const [organisation] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(crmOrgPartyMap)
    .where(eq(crmOrgPartyMap.organizationId, organizationId));
  return {
    LEAD: lead?.n ?? 0,
    CLIENT: client?.n ?? 0,
    CONTACT: contact?.n ?? 0,
    ORGANISATION: organisation?.n ?? 0,
  };
}
