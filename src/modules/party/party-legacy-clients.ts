import { and, eq, inArray } from "drizzle-orm";
import { clientPartyMap, partyRoles } from "../../db/schema/party";
import { CLIENT_MIRROR } from "./party-legacy-mirror";
import type { PartyRow } from "./party-mirror-fields";
import {
  absorbLeadColumn,
  convertedFromColumnOf,
  withoutSelfLinks,
} from "./party-legacy-associations";
import {
  applyPartyPatch,
  grantRole,
  insertBareParty,
  mintLegacyId,
  movePartiesFor,
  type ClientInsert,
  type ClientRow,
  type MirrorDb,
  type MirrorWriteOptions,
} from "./party-legacy-writer";

/**
 * The `clients` entry points, Party-first.
 *
 * Ticket 08's contract: nothing here writes the `clients` table any more. Every
 * function still returns a `ClientRow`, and it is the same row it always
 * returned -- the values were already **derived** from the Party by
 * `CLIENT_MIRROR.derive`, so the table was only ever handed a copy of what the
 * party already said. What it contributed on top was the serial id, and
 * migration 0277 moved that to `client_party_map`: the sequence `clients` used
 * to own is detached with `OWNED BY NONE`, the map column defaults from it, and
 * numbering continues unbroken. So `mintLegacyId` asks the map for the number
 * instead of asking a legacy insert what the number would have been.
 *
 * No delete here, because the legacy surface has never had one: `clients`
 * carries no `deleted_at`, so a soft-deleted party's client mirror could never
 * record the deletion at all. `PartyDivergenceService` reports that gap rather
 * than closing it by inventing a meaning for `clients.status`.
 *
 * One column does not go through the field map. `clients.lead_id` is an integer
 * `leads` id and its Party counterpart `converted_from_party_id` is a party id,
 * so translating needs `lead_party_map` and therefore a query -- which a
 * `MirrorCell` deliberately cannot do. Both directions run through
 * `party-legacy-associations.ts`, and nowhere else: `absorbLeadColumn` at each
 * of the three write paths below, and `convertedFromColumnOf` inside
 * `legacyClientRow`, which is now the single place the column is produced.
 */

async function partyIdsForClients(
  db: MirrorDb,
  organizationId: string,
  clientIds: readonly number[],
): Promise<Map<number, string>> {
  const rows = await db
    .select({ clientId: clientPartyMap.clientId, partyId: clientPartyMap.partyId })
    .from(clientPartyMap)
    .where(
      and(
        eq(clientPartyMap.organizationId, organizationId),
        inArray(clientPartyMap.clientId, [...clientIds]),
      ),
    );
  return new Map(rows.map((row) => [row.clientId, row.partyId]));
}

/**
 * A client row, assembled from the Party it mirrors.
 *
 * The values come from `CLIENT_MIRROR.derive` and nowhere else -- the same
 * derivation that used to be handed to `insert(clients)`. What the table
 * contributed on top was the serial and two timestamps, and Party carries both
 * timestamps already.
 *
 * Async, unlike the lead equivalent, because one of the columns is not in the
 * pure derivation: `lead_id` crosses an id space and needs `lead_party_map` to
 * cross it. Producing it here rather than at each call site is what makes the
 * column unforgettable -- `convertedFromColumnOf` answers with a whole column,
 * `null` included, so a client converted from nothing says so instead of
 * omitting the key and leaving the returned row a column short.
 *
 * `legacyOwnedPatch` still lands over the derivation, exactly where it landed in
 * the insert values it replaces. `id`, `orgId` and the timestamps go last for
 * the same reason the table put them last: they are not the caller's to choose.
 *
 * The `??` arm narrows `Partial<ClientInsert>` to the NOT NULL shape; it does not
 * decide it. The derivation is total over every column it owns, which the mirror
 * spec asserts separately.
 */
async function legacyClientRow(
  db: MirrorDb,
  organizationId: string,
  clientId: number,
  party: PartyRow,
  legacyOwnedPatch: Partial<ClientInsert>,
): Promise<ClientRow> {
  const derived = CLIENT_MIRROR.derive(party);

  return {
    ...derived,
    ...(await convertedFromColumnOf(db, organizationId, party.convertedFromPartyId)),
    ...legacyOwnedPatch,
    id: clientId,
    orgId: organizationId,
    name: derived.name ?? party.name,
    createdAt: party.createdAt,
    updatedAt: party.updatedAt,
  } as ClientRow;
}

export async function createMirroredClient(
  db: MirrorDb,
  organizationId: string,
  values: ClientInsert,
  options: MirrorWriteOptions = {},
): Promise<ClientRow> {
  return db.transaction(async (tx) => {
    const bare = await insertBareParty(tx, organizationId, values.name);
    const { partyPatch, legacyOwnedPatch } = CLIENT_MIRROR.split(values, bare);
    const party = await applyPartyPatch(
      tx,
      organizationId,
      bare.partyId,
      withoutSelfLinks(
        {
          // A client is a customer by the time it exists; 0241 stamped the same
          // stage on every backfilled client for the same reason.
          lifecycleStage: "CUSTOMER",
          ...partyPatch,
          ...(await absorbLeadColumn(tx, organizationId, values.leadId)),
        },
        bare.partyId,
      ),
    );

    /**
     * The identifier comes from the map now, not from a `clients` insert.
     *
     * The row this used to write was already derived from the Party above, so
     * the insert's only unique contribution was the number the serial handed
     * back. `client_party_map.client_id` defaults from that same sequence since
     * 0277, so the number is the one `clients` would have minted -- and it
     * survives the table being dropped, which is the whole point.
     */
    const clientId = await mintLegacyId(
      tx,
      organizationId,
      party.partyId,
      "CLIENT",
      options.linkedBy ?? "mirror:create",
    );
    const row = await legacyClientRow(tx, organizationId, clientId, party, legacyOwnedPatch);

    await grantRole(
      tx,
      organizationId,
      party.partyId,
      "CLIENT",
      options.linkedBy ?? "mirror:create",
    );
    // Read off the assembled row rather than off `party_type` directly, so the
    // role and the column it shadows can only ever be decided once.
    if (row.isVendor)
      await tx
        .insert(partyRoles)
        .values({
          organizationId,
          partyId: party.partyId,
          role: "VENDOR",
          assignedBy: options.linkedBy ?? "mirror:create",
        })
        .onConflictDoNothing();
    return row;
  });
}

export async function updateMirroredClients(
  db: MirrorDb,
  organizationId: string,
  clientIds: readonly number[],
  patch: Partial<ClientInsert>,
): Promise<ClientRow[]> {
  const ids = [...new Set(clientIds)].filter((id) => Number.isInteger(id));
  if (ids.length === 0) return [];

  return db.transaction(async (tx) => {
    /*
     * An id with no map row is an id that names nothing.
     *
     * There used to be an adoption pass here, for a `clients` row that existed
     * without a party -- the state the dual-write window could produce. Ticket
     * 08 removed the table it read, and with it the state: the map row IS the
     * client now, so `partyIdsForClients` returning nothing for an id means the
     * client does not exist, and the caller gets one fewer row back exactly as
     * it always did for an id that was never real.
     */
    const partyByClient = await partyIdsForClients(tx, organizationId, ids);

    /*
     * Resolved once, outside the per-party derivation: which lead the caller
     * named is a property of the patch, not of whoever is being patched, and a
     * bulk re-point of fifty clients should read the map once. The self-check is
     * not a property of the patch, so it stays inside.
     */
    const leadPatch = await absorbLeadColumn(tx, organizationId, patch.leadId);

    const moved = await movePartiesFor(
      tx,
      organizationId,
      [...new Set(partyByClient.values())],
      (party) =>
        withoutSelfLinks(
          { ...CLIENT_MIRROR.split(patch, party).partyPatch, ...leadPatch },
          party.partyId,
        ),
    );

    /**
     * What the caller is handed is assembled from what the party *became*, not
     * from the patch: a default or an `$onUpdate` column is decided by the write,
     * and echoing the patch back would report values the row does not hold.
     *
     * The `UPDATE clients` that used to produce these rows is gone, and with it
     * the `groupByPayload` that kept a bulk write to a handful of statements --
     * there is no second table left to write, so there is nothing to group. The
     * party updates are still grouped, inside `movePartiesFor`.
     */
    const updated: ClientRow[] = [];
    for (const [clientId, partyId] of partyByClient) {
      const party = moved.get(partyId);
      if (!party) continue;
      // The pass-through half does not depend on the party, so it is the same
      // for every row; the derivation is not, and is computed per party.
      const { legacyOwnedPatch } = CLIENT_MIRROR.split(patch, party);
      updated.push(await legacyClientRow(tx, organizationId, clientId, party, legacyOwnedPatch));
    }
    return updated;
  });
}

export async function updateMirroredClient(
  db: MirrorDb,
  organizationId: string,
  clientId: number,
  patch: Partial<ClientInsert>,
): Promise<ClientRow | undefined> {
  const [row] = await updateMirroredClients(db, organizationId, [clientId], patch);
  return row;
}
