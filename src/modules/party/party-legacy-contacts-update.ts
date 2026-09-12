import { and, eq, inArray, isNull } from "drizzle-orm";
import { businessParties, contactPartyMap } from "../../db/schema/party";
import { CONTACT_MIRROR } from "./party-legacy-mirror";
import {
  movePartiesFor,
  type ContactInsert,
  type ContactRow,
  type MirrorDb,
} from "./party-legacy-writer";
import { absorbEmployerColumn } from "./party-legacy-employer";
import {
  absorbLeadColumn,
  withoutSelfLinks,
} from "./party-legacy-associations";
import { partyIdsForContacts, legacyContactRow } from "./party-legacy-contacts-helpers";

export async function updateMirroredContacts(
  db: MirrorDb,
  organizationId: string,
  contactIds: readonly number[],
  patch: Partial<ContactInsert>,
): Promise<ContactRow[]> {
  const ids = [...new Set(contactIds)].filter((id) => Number.isInteger(id));
  if (ids.length === 0) return [];

  return db.transaction(async (tx) => {
    /*
     * An id with no map row is an id that names nothing.
     *
     * There used to be an adoption pass here, for a legacy row that existed
     * without a party -- the state the dual-write window could produce. Ticket
     * 08 removed the table it read, and with it the state: the map row IS the
     * record now, so no party for an id means the record does not exist, and
     * the caller gets one fewer row back exactly as it always did for an id
     * that was never real.
     */
    const partyByContact = await partyIdsForContacts(tx, organizationId, ids);

    /*
     * Resolved once, outside the per-party derivation: which company the caller
     * named is a property of the patch, not of whoever is being patched, and a
     * bulk re-point of fifty contacts should read the map once.
     */
    const employerPatch = await absorbEmployerColumn(tx, organizationId, patch.organizationId);
    const leadPatch = await absorbLeadColumn(tx, organizationId, patch.leadId);

    const moved = await movePartiesFor(
      tx,
      organizationId,
      [...new Set(partyByContact.values())],
      (party) =>
        withoutSelfLinks(
          { ...CONTACT_MIRROR.split(patch, party).partyPatch, ...employerPatch, ...leadPatch },
          party.partyId,
        ),
    );

    /*
     * The legacy UPDATE that used to close this out is gone with the table, and
     * with it the reason to group identical payloads: there is no statement left
     * whose count depends on how many of them agree. What replaces it is the
     * assembly, which is per contact because the identifier is -- one party can
     * legitimately answer for several after a merge re-points a map row, and each
     * of those contacts is still called what it was called.
     */
    const updated: ContactRow[] = [];
    for (const [contactId, partyId] of partyByContact) {
      const party = moved.get(partyId);
      if (!party) continue;
      // The pass-through half does not depend on the party, so it is the same
      // for every row; the derivation is not, and is computed per party.
      const { legacyOwnedPatch } = CONTACT_MIRROR.split(patch, party);
      updated.push(
        await legacyContactRow(tx, contactId, organizationId, party, legacyOwnedPatch),
      );
    }
    return updated;
  });
}

export async function updateMirroredContact(
  db: MirrorDb,
  organizationId: string,
  contactId: number,
  patch: Partial<ContactInsert>,
): Promise<ContactRow | undefined> {
  const [row] = await updateMirroredContacts(db, organizationId, [contactId], patch);
  return row;
}

/** Idempotent, for the reason recorded on `softDeleteMirroredLeads`. */
export async function softDeleteMirroredContacts(
  db: MirrorDb,
  organizationId: string,
  contactIds: readonly number[],
): Promise<ContactRow[]> {
  const ids = [...new Set(contactIds)].filter((id) => Number.isInteger(id));
  if (ids.length === 0) return [];
  /**
   * Liveness comes from the party. Ticket 08.
   *
   * This used to ask `contacts.deleted_at`, which was a mirror of
   * `business_parties.deleted_at` -- the party has always been the one that
   * decides. Asking it directly removes the last read of the table and changes
   * no answer: the map is what says which party a contact id means.
   *
   * The filter is still here rather than dropped. Its purpose is unchanged: a
   * contact already deleted must not have its timestamp moved by a second
   * delete.
   */
  const live = await db
    .select({ id: contactPartyMap.contactId })
    .from(contactPartyMap)
    .innerJoin(
      businessParties,
      and(
        eq(businessParties.organizationId, contactPartyMap.organizationId),
        eq(businessParties.partyId, contactPartyMap.partyId),
      ),
    )
    .where(
      and(
        eq(contactPartyMap.organizationId, organizationId),
        inArray(contactPartyMap.contactId, ids),
        isNull(businessParties.deletedAt),
      ),
    );
  return updateMirroredContacts(
    db,
    organizationId,
    live.map((row) => row.id),
    { deletedAt: new Date() },
  );
}
