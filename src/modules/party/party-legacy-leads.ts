import { and, eq, inArray, isNull } from "drizzle-orm";
import { leadPartyMap } from "../../db/schema/party";
import { leads } from "../../db/schema/crm/leads";
import { LEAD_MIRROR } from "./party-legacy-mirror";
import {
  applyPartyPatch,
  grantRoles,
  groupByPayload,
  insertBareParties,
  insertBareParty,
  movePartiesFor,
  type LeadInsert,
  type LeadRow,
  type MirrorDb,
  type MirrorWriteOptions,
} from "./party-legacy-writer";

/**
 * The `leads` entry points: create, update, soft-delete, all Party-first.
 *
 * Every function here writes `business_parties` before `leads` inside one
 * transaction, and the `leads` values come out of `LEAD_MIRROR.derive` rather
 * than from the caller -- see `party-legacy-mirror.ts` for why there is exactly
 * one derivation, and `party-legacy-writer.ts` for the machinery all three kinds
 * share.
 */

async function partyIdsForLeads(
  db: MirrorDb,
  organizationId: string,
  leadIds: readonly number[],
): Promise<Map<number, string>> {
  const rows = await db
    .select({ leadId: leadPartyMap.leadId, partyId: leadPartyMap.partyId })
    .from(leadPartyMap)
    .where(
      and(
        eq(leadPartyMap.organizationId, organizationId),
        inArray(leadPartyMap.leadId, [...leadIds]),
      ),
    );
  return new Map(rows.map((row) => [row.leadId, row.partyId]));
}

/**
 * Gives legacy rows that have no Party one, from their own current values.
 *
 * 0241 made the map total for every row that existed when it ran, and every
 * write path here keeps it total. A miss therefore means a row arrived by some
 * other route — a restore, an out-of-band import, a module not yet converted —
 * and the choice is between refusing the write and adopting the row. Refusing
 * would break a surface that worked yesterday; adopting reads the legacy row as
 * truth exactly once, which is correct precisely because there is no Party to
 * contradict it. `linked_by` records which rows came in this way.
 *
 * A whole set at a time, because the caller is a bulk update: the rows are read
 * once, the Parties minted in one insert, patched through the same grouped
 * writer the update path uses, and linked and roled in one statement each.
 */
async function adoptLeads(
  db: MirrorDb,
  organizationId: string,
  leadIds: readonly number[],
): Promise<Map<number, string>> {
  const adopted = new Map<number, string>();
  if (leadIds.length === 0) return adopted;

  const rows = await db
    .select()
    .from(leads)
    .where(and(eq(leads.orgId, organizationId), inArray(leads.id, [...leadIds])))
    .limit(leadIds.length);
  if (rows.length === 0) return adopted;

  const names = rows.map((row) => row.name);
  const partyIds = await insertBareParties(db, organizationId, names);
  const legacyByParty = new Map(
    rows.map((row, index): [string, LeadRow] => [partyIds[index], row]),
  );

  await movePartiesFor(db, organizationId, partyIds, (party) => {
    const legacy = legacyByParty.get(party.partyId);
    return legacy ? LEAD_MIRROR.split(legacy, party).partyPatch : {};
  });

  const links = rows.map((row, index) => ({
    organizationId,
    leadId: row.id,
    partyId: partyIds[index],
    linkedBy: "mirror:adopt",
  }));

  await db.insert(leadPartyMap).values(links).onConflictDoNothing();
  await grantRoles(db, organizationId, partyIds, "LEAD", "mirror:adopt");

  for (const link of links) adopted.set(link.leadId, link.partyId);
  return adopted;
}

export async function createMirroredLead(
  db: MirrorDb,
  organizationId: string,
  values: LeadInsert,
  options: MirrorWriteOptions = {},
): Promise<LeadRow> {
  return db.transaction(async (tx) => {
    const bare = await insertBareParty(tx, organizationId, values.name);
    const { partyPatch, legacyOwnedPatch } = LEAD_MIRROR.split(values, bare);
    const party = await applyPartyPatch(tx, organizationId, bare.partyId, partyPatch);

    const [row] = await tx
      .insert(leads)
      // `orgId` and `name` restated only so the required half of `LeadInsert` is
      // visibly satisfied; the spread that follows is what actually sets them,
      // and the spec asserts the derivation owns both columns.
      .values({
        orgId: organizationId,
        name: party.name,
        ...LEAD_MIRROR.derive(party),
        ...legacyOwnedPatch,
      })
      .returning();
    if (!row) throw new Error("Failed to mirror the party into leads");

    await tx.insert(leadPartyMap).values({
      organizationId,
      leadId: row.id,
      partyId: party.partyId,
      linkedBy: options.linkedBy ?? "mirror:create",
    });
    await grantRoles(
      tx,
      organizationId,
      [party.partyId],
      "LEAD",
      options.linkedBy ?? "mirror:create",
    );
    return row;
  });
}

/**
 * Many leads, one transaction, still Party-first.
 *
 * The importer inserts in chunks and reports a whole chunk as failed if any row
 * in it is rejected, so this has to behave the same way a single multi-row
 * `insert(...).values(rows)` did: all of it lands or none of it does.
 */
export async function createMirroredLeads(
  db: MirrorDb,
  organizationId: string,
  rows: readonly LeadInsert[],
  options: MirrorWriteOptions = {},
): Promise<LeadRow[]> {
  if (rows.length === 0) return [];
  return db.transaction(async (tx) => {
    const created: LeadRow[] = [];
    for (const values of rows)
      created.push(await createMirroredLead(tx, organizationId, values, options));
    return created;
  });
}

export async function updateMirroredLeads(
  db: MirrorDb,
  organizationId: string,
  leadIds: readonly number[],
  patch: Partial<LeadInsert>,
): Promise<LeadRow[]> {
  const ids = [...new Set(leadIds)].filter((id) => Number.isInteger(id));
  if (ids.length === 0) return [];

  return db.transaction(async (tx) => {
    const partyByLead = await partyIdsForLeads(tx, organizationId, ids);
    const unadopted = ids.filter((leadId) => !partyByLead.has(leadId));
    const adopted = await adoptLeads(tx, organizationId, unadopted);
    for (const [leadId, partyId] of adopted) partyByLead.set(leadId, partyId);

    const moved = await movePartiesFor(
      tx,
      organizationId,
      [...new Set(partyByLead.values())],
      (party) => LEAD_MIRROR.split(patch, party).partyPatch,
    );

    const derived: { id: number; payload: Partial<LeadInsert> }[] = [];
    for (const [leadId, partyId] of partyByLead) {
      const party = moved.get(partyId);
      if (!party) continue;
      // The pass-through half does not depend on the party, so it is the same
      // for every row; the derivation is not, and is computed per party.
      const { legacyOwnedPatch } = LEAD_MIRROR.split(patch, party);
      derived.push({ id: leadId, payload: { ...LEAD_MIRROR.derive(party), ...legacyOwnedPatch } });
    }

    const updated: LeadRow[] = [];
    for (const group of groupByPayload(derived)) {
      const rows = await tx
        .update(leads)
        .set(group.payload)
        .where(and(eq(leads.orgId, organizationId), inArray(leads.id, group.ids)))
        .returning();
      updated.push(...rows);
    }
    return updated;
  });
}

export async function updateMirroredLead(
  db: MirrorDb,
  organizationId: string,
  leadId: number,
  patch: Partial<LeadInsert>,
): Promise<LeadRow | undefined> {
  const [row] = await updateMirroredLeads(db, organizationId, [leadId], patch);
  return row;
}

/**
 * Idempotent, matching the `WHERE deleted_at IS NULL` the legacy updates carried:
 * deleting an already-deleted record must not move the timestamp that says when
 * it went.
 */
export async function softDeleteMirroredLeads(
  db: MirrorDb,
  organizationId: string,
  leadIds: readonly number[],
): Promise<LeadRow[]> {
  const ids = [...new Set(leadIds)].filter((id) => Number.isInteger(id));
  if (ids.length === 0) return [];
  const live = await db
    .select({ id: leads.id })
    .from(leads)
    .where(
      and(eq(leads.orgId, organizationId), inArray(leads.id, ids), isNull(leads.deletedAt)),
    );
  return updateMirroredLeads(
    db,
    organizationId,
    live.map((row) => row.id),
    { deletedAt: new Date() },
  );
}
