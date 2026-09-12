import { and, eq, inArray, isNull } from "drizzle-orm";
import { businessParties, leadPartyMap } from "../../db/schema/party";
import { LEAD_MIRROR } from "./party-legacy-mirror";
import type { PartyRow } from "./party-mirror-fields";
import {
  applyPartyPatch,
  grantRole,
  insertBareParty,
  movePartiesFor,
  type LeadInsert,
  type LeadRow,
  type MirrorDb,
  type MirrorWriteOptions,
  mintLegacyId,
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
 * Gives a legacy row that has no Party one, from its own current values.
 *
 * 0241 made the map total for every row that existed when it ran, and every
 * write path here keeps it total. A miss therefore means a row arrived by some
 * other route — a restore, an out-of-band import, a module not yet converted —
 * and the choice is between refusing the write and adopting the row. Refusing
 * would break a surface that worked yesterday; adopting reads the legacy row as
 * truth exactly once, which is correct precisely because there is no Party to
 * contradict it. `linked_by` records which rows came in this way.
 */
/**
 * A lead row, assembled from the Party it mirrors.
 *
 * The values come from `LEAD_MIRROR.derive` and nowhere else -- the same
 * derivation that used to be handed to `insert(leads)`. What the table
 * contributed on top was the serial and two timestamps, and Party carries both
 * timestamps already.
 *
 * The `??` arms narrow `Partial<LeadInsert>` to the NOT NULL shape; they do not
 * decide it. The derivation is total over every column it owns, which the mirror
 * spec asserts separately.
 */
function legacyLeadRow(
  leadId: number,
  organizationId: string,
  party: PartyRow,
  legacyOwnedPatch: Partial<LeadInsert>,
): LeadRow {
  const derived = LEAD_MIRROR.derive(party);

  return {
    ...derived,
    ...legacyOwnedPatch,
    id: leadId,
    orgId: organizationId,
    name: derived.name ?? party.name,
    createdAt: party.createdAt,
    updatedAt: party.updatedAt,
    deletedAt: party.deletedAt,
  } as LeadRow;
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

    /**
     * The identifier comes from the map now, not from a `leads` insert.
     *
     * Ticket 08's contract. The row this used to write was already **derived**
     * from the Party -- `LEAD_MIRROR.derive(party)` produced every mirrored
     * column and the table only added the serial and its timestamps. So the
     * table was contributing one thing that mattered: the number. Migration 0277
     * moved the minting to `lead_party_map`, and the shape is assembled from the
     * same derivation that would have been written.
     *
     * That is why this is not a behaviour change dressed as a refactor: the
     * values are identical, and the divergence check that used to compare them
     * has nothing left to compare because there is only one copy.
     */
    const leadId = await mintLegacyId(
      tx,
      organizationId,
      party.partyId,
      "LEAD",
      options.linkedBy ?? "mirror:create",
    );
    await grantRole(tx, organizationId, party.partyId, "LEAD", options.linkedBy ?? "mirror:create");

    return legacyLeadRow(leadId, organizationId, party, legacyOwnedPatch);
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
    const partyByLead = await partyIdsForLeads(tx, organizationId, ids);

    const moved = await movePartiesFor(
      tx,
      organizationId,
      [...new Set(partyByLead.values())],
      (party) => LEAD_MIRROR.split(patch, party).partyPatch,
    );

    /**
     * Assembled from the parties, not read back from an UPDATE. Ticket 08.
     *
     * The payload this used to write was `derive(party)` plus the pass-through
     * half — exactly what `legacyLeadRow` assembles — so the values are the same
     * ones, and the UPDATE was only ever a way of storing a second copy of them.
     *
     * `groupByPayload` goes with it. It existed to collapse rows sharing a
     * payload into one UPDATE, and there is no UPDATE to collapse; the party
     * writes are still grouped, inside `movePartiesFor`.
     */
    const updated: LeadRow[] = [];
    for (const [leadId, partyId] of partyByLead) {
      const party = moved.get(partyId);
      if (!party) continue;
      const { legacyOwnedPatch } = LEAD_MIRROR.split(patch, party);
      updated.push(legacyLeadRow(leadId, organizationId, party, legacyOwnedPatch));
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
 *
 * Liveness is read from the Party, because that is where `deleted_at` now lives.
 * This asked `leads` directly, which for a lead created through the mirror is a
 * table with no row in it — so the probe returned nothing, the delete became a
 * silent no-op, and the caller got an empty array rather than an error.
 */
export async function softDeleteMirroredLeads(
  db: MirrorDb,
  organizationId: string,
  leadIds: readonly number[],
): Promise<LeadRow[]> {
  const ids = [...new Set(leadIds)].filter((id) => Number.isInteger(id));
  if (ids.length === 0) return [];
  /**
   * Liveness comes from the party. Ticket 08.
   *
   * This used to ask `leads.deleted_at`, which was a mirror of
   * `business_parties.deleted_at` — the party has always been the one that
   * decides. Asking it directly removes the last read of the table and changes
   * no answer: the map is what says which party a lead id means.
   *
   * The filter is still here rather than dropped. Its purpose is unchanged: a
   * lead already deleted must not have its timestamp moved by a second delete.
   */
  const live = await db
    .select({ id: leadPartyMap.leadId })
    .from(leadPartyMap)
    .innerJoin(
      businessParties,
      and(
        eq(businessParties.organizationId, leadPartyMap.organizationId),
        eq(businessParties.partyId, leadPartyMap.partyId),
      ),
    )
    .where(
      and(
        eq(leadPartyMap.organizationId, organizationId),
        inArray(leadPartyMap.leadId, ids),
        isNull(businessParties.deletedAt),
      ),
    );
  return updateMirroredLeads(
    db,
    organizationId,
    live.map((row) => row.id),
    { deletedAt: new Date() },
  );
}
