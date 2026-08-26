import { and, eq, inArray } from "drizzle-orm";
import { clientPartyMap, partyRoles } from "../../db/schema/party";
import { clients } from "../../db/schema/crm/contacts";
import { CLIENT_MIRROR } from "./party-legacy-mirror";
import {
  absorbLeadColumn,
  convertedFromColumnOf,
  withoutSelfLinks,
} from "./party-legacy-associations";
import {
  applyPartyPatch,
  grantRole,
  groupByPayload,
  insertBareParty,
  movePartiesFor,
  type ClientInsert,
  type ClientRow,
  type MirrorDb,
  type MirrorWriteOptions,
} from "./party-legacy-writer";

/**
 * The `clients` entry points, Party-first.
 *
 * No delete here, because the legacy surface has never had one: `clients`
 * carries no `deleted_at`, so a soft-deleted party's client mirror cannot record
 * the deletion at all. `PartyDivergenceService` reports that gap rather than
 * closing it by inventing a meaning for `clients.status`.
 *
 * One column does not go through the field map. `clients.lead_id` is an integer
 * `leads` id and its Party counterpart `converted_from_party_id` is a party id,
 * so translating needs `lead_party_map` and therefore a query -- which a
 * `MirrorCell` deliberately cannot do. Both directions run through
 * `party-legacy-associations.ts` at the three points below, and nowhere else.
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

async function adoptClient(
  db: MirrorDb,
  organizationId: string,
  clientId: number,
): Promise<string | null> {
  const [row] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.orgId, organizationId)))
    .limit(1);
  if (!row) return null;

  const party = await insertBareParty(db, organizationId, row.name);
  const { partyPatch } = CLIENT_MIRROR.split(row, party);
  await applyPartyPatch(
    db,
    organizationId,
    party.partyId,
    withoutSelfLinks(
      { ...partyPatch, ...(await absorbLeadColumn(db, organizationId, row.leadId)) },
      party.partyId,
    ),
  );
  await db
    .insert(clientPartyMap)
    .values({ organizationId, clientId, partyId: party.partyId, linkedBy: "mirror:adopt" })
    .onConflictDoNothing();
  await grantRole(db, organizationId, party.partyId, "CLIENT", "mirror:adopt");
  return party.partyId;
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

    const [row] = await tx
      .insert(clients)
      .values({
        orgId: organizationId,
        name: party.name,
        ...CLIENT_MIRROR.derive(party),
        ...(await convertedFromColumnOf(tx, organizationId, party.convertedFromPartyId)),
        ...legacyOwnedPatch,
      })
      .returning();
    if (!row) throw new Error("Failed to mirror the party into clients");

    await tx.insert(clientPartyMap).values({
      organizationId,
      clientId: row.id,
      partyId: party.partyId,
      linkedBy: options.linkedBy ?? "mirror:create",
    });
    await grantRole(
      tx,
      organizationId,
      party.partyId,
      "CLIENT",
      options.linkedBy ?? "mirror:create",
    );
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
    const partyByClient = await partyIdsForClients(tx, organizationId, ids);
    for (const clientId of ids) {
      if (partyByClient.has(clientId)) continue;
      const adopted = await adoptClient(tx, organizationId, clientId);
      if (adopted) partyByClient.set(clientId, adopted);
    }

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

    const derived: { id: number; payload: Partial<ClientInsert> }[] = [];
    for (const [clientId, partyId] of partyByClient) {
      const party = moved.get(partyId);
      if (!party) continue;
      // The pass-through half does not depend on the party, so it is the same
      // for every row; the derivation is not, and is computed per party.
      const { legacyOwnedPatch } = CLIENT_MIRROR.split(patch, party);
      derived.push({
        id: clientId,
        payload: {
          ...CLIENT_MIRROR.derive(party),
          ...(await convertedFromColumnOf(tx, organizationId, party.convertedFromPartyId)),
          ...legacyOwnedPatch,
        },
      });
    }

    const updated: ClientRow[] = [];
    for (const group of groupByPayload(derived)) {
      const rows = await tx
        .update(clients)
        .set(group.payload)
        .where(and(eq(clients.orgId, organizationId), inArray(clients.id, group.ids)))
        .returning();
      updated.push(...rows);
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
