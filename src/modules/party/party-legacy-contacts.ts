import { and, eq, inArray, isNull } from "drizzle-orm";
import { contactPartyMap } from "../../db/schema/party";
import { contacts } from "../../db/schema/crm/contacts";
import { CONTACT_MIRROR } from "./party-legacy-mirror";
import {
  applyPartyPatch,
  employerColumnOf,
  grantRoles,
  groupByPayload,
  insertBareParties,
  insertBareParty,
  movePartiesFor,
  type ContactInsert,
  type ContactRow,
  type MirrorDb,
  type MirrorWriteOptions,
} from "./party-legacy-writer";
import {
  absorbEmployerColumn,
  employerLegacyIds,
  linkedPartyId,
  partyIdsOfCrmOrgs,
} from "./party-legacy-employer";
import {
  absorbLeadColumn,
  convertedFromColumnOf,
  leadIdsOfParties,
  partyIdsOfLeads,
  withoutSelfLinks,
} from "./party-legacy-associations";

/**
 * The `contacts` entry points, Party-first.
 *
 * Two columns skip the field map: `organization_id` is an integer
 * `crm_organizations` id against a party id and `lead_id` an integer `leads` id
 * against another, so both need a `*_party_map` read — which a `MirrorCell`
 * deliberately cannot do. They run through `party-legacy-employer.ts` and
 * `party-legacy-associations.ts` and nowhere else, and every path below reads
 * those maps ONCE per set. `deal_id` is not one: it is the same integer `deals`
 * id as `primary_deal_id`, so it stays a cell.
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

const unresolvedEmployer = (id: number): string =>
  `Organization ${id} has no party in this tenant; run the 0264 backfill before pointing an employer at it`;

const unresolvedLead = (id: number): string =>
  `Lead ${id} has no party in this tenant; run the 0241 backfill before converting from it`;

async function adoptContacts(
  db: MirrorDb,
  organizationId: string,
  contactIds: readonly number[],
): Promise<Map<number, string>> {
  const adopted = new Map<number, string>();
  if (contactIds.length === 0) return adopted;

  const rows = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.orgId, organizationId), inArray(contacts.id, [...contactIds])))
    .limit(contactIds.length);
  if (rows.length === 0) return adopted;

  const employerIds = rows
    .map((row) => row.organizationId)
    .filter((id): id is number => id !== null);
  const sourceLeadIds = rows.map((row) => row.leadId).filter((id): id is number => id !== null);
  const partyByEmployer = await partyIdsOfCrmOrgs(db, organizationId, employerIds);
  const partyByLead = await partyIdsOfLeads(db, organizationId, sourceLeadIds);

  const partyIds = await insertBareParties(db, organizationId, rows.map((row) => row.name));
  const legacyByParty = new Map(
    rows.map((row, index): [string, ContactRow] => [partyIds[index], row]),
  );

  await movePartiesFor(db, organizationId, partyIds, (party) => {
    const legacy = legacyByParty.get(party.partyId);
    if (!legacy) return {};
    return withoutSelfLinks(
      {
        ...CONTACT_MIRROR.split(legacy, party).partyPatch,
        employerPartyId: linkedPartyId(partyByEmployer, legacy.organizationId, unresolvedEmployer),
        convertedFromPartyId: linkedPartyId(partyByLead, legacy.leadId, unresolvedLead),
      },
      party.partyId,
    );
  });

  const links = rows.map((row, index) => ({
    organizationId,
    contactId: row.id,
    partyId: partyIds[index],
    linkedBy: "mirror:adopt",
  }));

  await db.insert(contactPartyMap).values(links).onConflictDoNothing();
  await grantRoles(db, organizationId, partyIds, "CONTACT", "mirror:adopt");

  for (const link of links) adopted.set(link.contactId, link.partyId);
  return adopted;
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
    await grantRoles(
      tx,
      organizationId,
      [party.partyId],
      "CONTACT",
      options.linkedBy ?? "mirror:create",
    );
    return row;
  });
}

/**
 * Many contacts, one transaction, still Party-first: the importer bisects a
 * failing chunk, so all of it lands or none of it does.
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
    const unadopted = ids.filter((contactId) => !partyByContact.has(contactId));
    const adopted = await adoptContacts(tx, organizationId, unadopted);
    for (const [contactId, partyId] of adopted) partyByContact.set(contactId, partyId);

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

    const movedParties = [...moved.values()];
    const employerPartyIds = movedParties.map((party) => party.employerPartyId);
    const employerLegacyByParty = await employerLegacyIds(tx, organizationId, employerPartyIds);
    const sourcePartyIds = movedParties
      .map((party) => party.convertedFromPartyId)
      .filter((id): id is string => id !== null);
    const leadIdBySource = await leadIdsOfParties(tx, organizationId, sourcePartyIds);

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
          organizationId: party.employerPartyId
            ? (employerLegacyByParty.get(party.employerPartyId) ?? null)
            : null,
          leadId: party.convertedFromPartyId
            ? (leadIdBySource.get(party.convertedFromPartyId) ?? null)
            : null,
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
