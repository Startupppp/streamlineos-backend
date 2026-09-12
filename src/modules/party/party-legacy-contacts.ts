import { CONTACT_MIRROR } from "./party-legacy-mirror";
import {
  applyPartyPatch,
  grantRole,
  insertBareParty,
  mintLegacyId,
  type ContactInsert,
  type ContactRow,
  type MirrorDb,
  type MirrorWriteOptions,
} from "./party-legacy-writer";
import { absorbEmployerColumn } from "./party-legacy-employer";
import {
  absorbLeadColumn,
  withoutSelfLinks,
} from "./party-legacy-associations";
import { legacyContactRow } from "./party-legacy-contacts-helpers";
export { updateMirroredContacts, updateMirroredContact, softDeleteMirroredContacts } from "./party-legacy-contacts-update";

/**
 * The `contacts` entry points, Party-first.
 *
 * Ticket 08's contract: none of these writes the `contacts` table any more. The
 * row each of them used to insert or update was already **derived** from the
 * Party -- `CONTACT_MIRROR.derive(party)` produced every mirrored column and the
 * table only added the serial and its two timestamps. So the table contributed
 * exactly one thing that mattered: the number. Migration 0277 moved the minting
 * to `contact_party_map`, whose integer column defaults from the sequence
 * `contacts` used to own, detached with `OWNED BY NONE` so `DROP TABLE` cannot
 * take it. Numbering continues unbroken and a record keeps the name it had.
 *
 * The shape each function hands back is therefore assembled from the same
 * derivation that would have been written, which is why this is not a behaviour
 * change dressed as a refactor: the values are identical, and there is now only
 * one copy of them.
 *
 * Two columns here do not go through the field map, and for one reason.
 * `contacts.organization_id` is an integer `crm_organizations` id whose Party
 * counterpart `employer_party_id` is a party id; `contacts.lead_id` is an integer
 * `leads` id whose counterpart `converted_from_party_id` is a party id. Both
 * translations need a `*_party_map` table and therefore a query — which a
 * `MirrorCell` deliberately cannot do. They run through `party-legacy-employer.ts`
 * and `party-legacy-associations.ts` on both sides of every write below, and
 * nowhere else.
 *
 * `contacts.deal_id` is NOT one of them, despite looking like one: it and
 * `primary_deal_id` are the same integer `deals` id, so it is an ordinary cell in
 * `party-mirror-fields.ts` and arrives here through `split` and `derive` like
 * every other column.
 */

export async function createMirroredContact(
  db: MirrorDb,
  organizationId: string,
  values: ContactInsert,
  options: MirrorWriteOptions = {},
): Promise<ContactRow> {
  return db.transaction(async (tx) => {
    const bare = await insertBareParty(tx, organizationId, values.name);
    const { partyPatch, legacyOwnedPatch } = CONTACT_MIRROR.split(values, bare);
    const party = await applyPartyPatch(
      tx,
      organizationId,
      bare.partyId,
      withoutSelfLinks(
        {
          ...partyPatch,
          ...(await absorbEmployerColumn(tx, organizationId, values.organizationId)),
          ...(await absorbLeadColumn(tx, organizationId, values.leadId)),
        },
        bare.partyId,
      ),
    );

    // The identifier comes from the map now, not from a `contacts` insert; see
    // `mintLegacyId` and the note at the top of this file.
    const contactId = await mintLegacyId(
      tx,
      organizationId,
      party.partyId,
      "CONTACT",
      options.linkedBy ?? "mirror:create",
    );
    await grantRole(
      tx,
      organizationId,
      party.partyId,
      "CONTACT",
      options.linkedBy ?? "mirror:create",
    );

    return legacyContactRow(tx, contactId, organizationId, party, legacyOwnedPatch);
  });
}

/**
 * Many contacts, one transaction, still Party-first.
 *
 * The importer inserts in chunks and bisects a failing chunk, so this has to
 * behave the same way a plain `insert(...).values(rows)` did: all of it lands or
 * none of it does.
 */
export async function createMirroredContacts(
  db: MirrorDb,
  organizationId: string,
  rows: readonly ContactInsert[],
  options: MirrorWriteOptions = {},
): Promise<ContactRow[]> {
  if (rows.length === 0) return [];
  return db.transaction(async (tx) => {
    const created: ContactRow[] = [];
    for (const values of rows)
      created.push(await createMirroredContact(tx, organizationId, values, options));
    return created;
  });
}
