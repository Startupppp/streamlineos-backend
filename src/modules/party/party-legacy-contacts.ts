import { and, eq, inArray, isNull } from "drizzle-orm";
import { contactPartyMap } from "../../db/schema/party";
import { contacts } from "../../db/schema/crm/contacts";
import { CONTACT_MIRROR } from "./party-legacy-mirror";
import {
  applyPartyPatch,
  employerColumnOf,
  grantRole,
  groupByPayload,
  insertBareParty,
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
 * Two columns here do not go through the field map, and for one reason.
 * `contacts.organization_id` is an integer `crm_organizations` id whose Party
 * counterpart `employer_party_id` is a party id; `contacts.lead_id` is an integer
 * `leads` id whose counterpart `converted_from_party_id` is a party id. Both
 * translations need a `*_party_map` table and therefore a query — which a
 * `MirrorCell` deliberately cannot do. They run through `party-legacy-employer.ts`
 * and `party-legacy-associations.ts` at the three points below, and nowhere else.
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

    const [row] = await tx
      .insert(contacts)
      .values({
        orgId: organizationId,
        name: party.name,
        ...CONTACT_MIRROR.derive(party),
        ...(await employerColumnOf(tx, organizationId, party)),
        ...(await convertedFromColumnOf(tx, organizationId, party.convertedFromPartyId)),
        ...legacyOwnedPatch,
      })
      .returning();
    if (!row) throw new Error("Failed to mirror the party into contacts");

    await tx.insert(contactPartyMap).values({
      organizationId,
      contactId: row.id,
      partyId: party.partyId,
      linkedBy: options.linkedBy ?? "mirror:create",
    });
    await grantRole(
      tx,
      organizationId,
      party.partyId,
      "CONTACT",
      options.linkedBy ?? "mirror:create",
    );
    return row;
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

    const derived: { id: number; payload: Partial<ContactInsert> }[] = [];
    for (const [contactId, partyId] of partyByContact) {
      const party = moved.get(partyId);
      if (!party) continue;
      // The pass-through half does not depend on the party, so it is the same
      // for every row; the derivation is not, and is computed per party.
      const { legacyOwnedPatch } = CONTACT_MIRROR.split(patch, party);
      derived.push({
        id: contactId,
        payload: {
          ...CONTACT_MIRROR.derive(party),
          ...(await employerColumnOf(tx, organizationId, party)),
          ...(await convertedFromColumnOf(tx, organizationId, party.convertedFromPartyId)),
          ...legacyOwnedPatch,
        },
      });
    }

    const updated: ContactRow[] = [];
    for (const group of groupByPayload(derived)) {
      const rows = await tx
        .update(contacts)
        .set(group.payload)
        .where(and(eq(contacts.orgId, organizationId), inArray(contacts.id, group.ids)))
        .returning();
      updated.push(...rows);
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
