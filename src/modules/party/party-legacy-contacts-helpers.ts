import { and, eq, inArray } from "drizzle-orm";
import { contactPartyMap } from "../../db/schema/party";
import { CONTACT_MIRROR } from "./party-legacy-mirror";
import type { PartyRow } from "./party-mirror-fields";
import {
  type ContactInsert,
  type ContactRow,
  type MirrorDb,
} from "./party-legacy-writer";
import { employerColumnOf } from "./party-legacy-writer";
import { convertedFromColumnOf } from "./party-legacy-associations";

export async function partyIdsForContacts(
  db: MirrorDb,
  organizationId: string,
  contactIds: readonly number[],
): Promise<Map<number, string>> {
  const rows = await db
    .select({ contactId: contactPartyMap.contactId, partyId: contactPartyMap.partyId })
    .from(contactPartyMap)
    .where(
      and(
        eq(contactPartyMap.organizationId, organizationId),
        inArray(contactPartyMap.contactId, [...contactIds]),
      ),
    );
  return new Map(rows.map((row) => [row.contactId, row.partyId]));
}

/**
 * A contact row, assembled from the Party it mirrors.
 *
 * The mirrored values come from `CONTACT_MIRROR.derive` and nowhere else -- the
 * same derivation that used to be handed to `insert(contacts)`. The two
 * association columns are added by the same translations the insert used, for
 * the reason recorded at the top of `party-legacy-contacts.ts`: they cross an id
 * space, so they need a query and cannot be cells.
 *
 * Asynchronous for exactly that reason, and the one way this differs from
 * `legacyLeadRow` in `party-legacy-leads.ts`. A lead's legacy-owned columns are
 * all pass-through; a contact's two are resolved.
 *
 * `merged_into_id` is the only contact column with no Party source at all, and
 * it defaults to null rather than being left absent: `CONTACT_PARTY_COLUMNS`
 * already projects it as a literal `null::integer` on every read, because the
 * merge that sets it sets `deleted_at` in the same breath and the party scope
 * excludes deleted parties. Answering null here is what the read surface says,
 * and it keeps the returned shape total. A caller that names it explicitly --
 * the contact merge does -- still has its value carried through.
 *
 * The `??` arm narrows `Partial<ContactInsert>` to the NOT NULL shape; it does
 * not decide it. The derivation is total over every column it owns, which the
 * mirror spec asserts separately.
 */
export async function legacyContactRow(
  db: MirrorDb,
  contactId: number,
  organizationId: string,
  party: PartyRow,
  legacyOwnedPatch: Partial<ContactInsert>,
): Promise<ContactRow> {
  const derived = CONTACT_MIRROR.derive(party);

  return {
    mergedIntoId: null,
    ...derived,
    ...(await employerColumnOf(db, organizationId, party)),
    ...(await convertedFromColumnOf(db, organizationId, party.convertedFromPartyId)),
    ...legacyOwnedPatch,
    id: contactId,
    orgId: organizationId,
    name: derived.name ?? party.name,
    createdAt: party.createdAt,
    updatedAt: party.updatedAt,
    deletedAt: party.deletedAt,
  } as ContactRow;
}
