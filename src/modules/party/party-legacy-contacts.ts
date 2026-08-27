import { and, eq, inArray, isNull } from "drizzle-orm";
import { contactPartyMap } from "../../db/schema/party";
import { contacts } from "../../db/schema/crm/contacts";
import { CONTACT_MIRROR } from "./party-legacy-mirror";
import type { PartyRow } from "./party-mirror-fields";
import {
  applyPartyPatch,
  employerColumnOf,
  grantRole,
  insertBareParty,
  mintLegacyId,
  movePartiesFor,
  type ContactInsert,
  type ContactRow,
  type MirrorDb,
  type MirrorWriteOptions,
} from "./party-legacy-writer";
import { absorbEmployerColumn } from "./party-legacy-employer";
import {
  absorbLeadColumn,
  convertedFromColumnOf,
  withoutSelfLinks,
} from "./party-legacy-associations";

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

async function partyIdsForContacts(
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

async function adoptContact(
  db: MirrorDb,
  organizationId: string,
  contactId: number,
): Promise<string | null> {
  const [row] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.orgId, organizationId)))
    .limit(1);
  if (!row) return null;

  const party = await insertBareParty(db, organizationId, row.name);
  const { partyPatch } = CONTACT_MIRROR.split(row, party);
  await applyPartyPatch(
    db,
    organizationId,
    party.partyId,
    withoutSelfLinks(
      {
        ...partyPatch,
        ...(await absorbEmployerColumn(db, organizationId, row.organizationId)),
        ...(await absorbLeadColumn(db, organizationId, row.leadId)),
      },
      party.partyId,
    ),
  );
  await db
    .insert(contactPartyMap)
    .values({ organizationId, contactId, partyId: party.partyId, linkedBy: "mirror:adopt" })
    .onConflictDoNothing();
  await grantRole(db, organizationId, party.partyId, "CONTACT", "mirror:adopt");
  return party.partyId;
}

/**
 * A contact row, assembled from the Party it mirrors.
 *
 * The mirrored values come from `CONTACT_MIRROR.derive` and nowhere else -- the
 * same derivation that used to be handed to `insert(contacts)`. The two
 * association columns are added by the same translations the insert used, for
 * the reason recorded at the top of this file: they cross an id space, so they
 * need a query and cannot be cells.
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
async function legacyContactRow(
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

export async function updateMirroredContacts(
  db: MirrorDb,
  organizationId: string,
  contactIds: readonly number[],
  patch: Partial<ContactInsert>,
): Promise<ContactRow[]> {
  const ids = [...new Set(contactIds)].filter((id) => Number.isInteger(id));
  if (ids.length === 0) return [];

  return db.transaction(async (tx) => {
    const partyByContact = await partyIdsForContacts(tx, organizationId, ids);
    for (const contactId of ids) {
      if (partyByContact.has(contactId)) continue;
      const adopted = await adoptContact(tx, organizationId, contactId);
      if (adopted) partyByContact.set(contactId, adopted);
    }

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
  const live = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(eq(contacts.orgId, organizationId), inArray(contacts.id, ids), isNull(contacts.deletedAt)),
    );
  return updateMirroredContacts(
    db,
    organizationId,
    live.map((row) => row.id),
    { deletedAt: new Date() },
  );
}
