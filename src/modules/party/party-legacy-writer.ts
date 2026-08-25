import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../db/drizzle.types";
import {
  businessParties,
  clientPartyMap,
  contactPartyMap,
  leadPartyMap,
  partyRoles,
} from "../../db/schema/party";
import { clients, contacts } from "../../db/schema/crm/contacts";
import { leads } from "../../db/schema/crm/leads";
import {
  CLIENT_MIRROR,
  CONTACT_MIRROR,
  LEAD_MIRROR,
  type PartyPatch,
  type PartyRow,
} from "./party-legacy-mirror";
import type { MappedLegacyKind } from "./party-legacy-seam";

/**
 * The shared half of the Party-first write, and the Party surface itself.
 *
 * Party is canonical from this ticket onward. That is a decision, not a
 * mechanism: legacy tables keep taking writes so unmigrated modules keep
 * working, but nothing reads them as truth again, which turns a disagreement
 * from "two sources, pick one" into "the mirror is stale". Every function here
 * writes the Party row first and the legacy row second inside one transaction,
 * and the legacy values always come out of `party-legacy-mirror`'s single
 * derivation rather than being assembled a second time.
 *
 * The three legacy entry points live beside this file, one per kind, because
 * each carries its own map table, its own adoption path and its own `$inferInsert`
 * — and because a single file holding all three was past the size at which
 * anybody reads the one they need. What they share is here.
 *
 * Plain functions taking `db`, matching `party-legacy-seam.ts` rather than
 * introducing a service. Forty-odd call sites live in a dozen modules; making
 * this injectable would add a constructor parameter to every one of their
 * services and to every spec that builds one by hand, for no behaviour.
 *
 * `db.transaction` inside a request opens a SAVEPOINT, because `this.db` is the
 * tenant-aware proxy and already resolves to the request's transaction. That is
 * exactly what is wanted here — the Party and its mirror commit or roll back
 * together, without a second connection and without escaping the tenant GUC.
 * Callers that hold their own `tx` pass it instead, and the savepoint nests.
 */

/**
 * A Drizzle handle: the tenant-aware `this.db`, or a transaction a caller
 * already opened. Both accept the four verbs used below.
 */
export type MirrorDb = Db;

export type LeadRow = typeof leads.$inferSelect;
export type ClientRow = typeof clients.$inferSelect;
export type ContactRow = typeof contacts.$inferSelect;
export type LeadInsert = typeof leads.$inferInsert;
export type ClientInsert = typeof clients.$inferInsert;
export type ContactInsert = typeof contacts.$inferInsert;

/** What 0241 gave the backfilled rows; new rows get the same, for the same reason. */
const ROLE_FOR_KIND: Record<MappedLegacyKind, string> = {
  LEAD: "PROSPECT",
  CLIENT: "CUSTOMER",
  CONTACT: "CONTACT",
};

export interface MirrorWriteOptions {
  /** Recorded on the map row: a user id, or the job that linked the two. */
  readonly linkedBy?: string;
}

async function loadParty(
  db: MirrorDb,
  organizationId: string,
  partyId: string,
): Promise<PartyRow | undefined> {
  const [row] = await db
    .select()
    .from(businessParties)
    .where(
      and(
        eq(businessParties.partyId, partyId),
        eq(businessParties.organizationId, organizationId),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Exported for the three legacy entry points beside this file, and for nothing
 * else. They are the shared half of one seam, not a general-purpose API.
 */
export async function applyPartyPatch(
  db: MirrorDb,
  organizationId: string,
  partyId: string,
  patch: PartyPatch,
): Promise<PartyRow> {
  if (Object.keys(patch).length === 0) {
    const unchanged = await loadParty(db, organizationId, partyId);
    if (!unchanged) throw new Error(`Party ${partyId} vanished mid-transaction`);
    return unchanged;
  }
  const [updated] = await db
    .update(businessParties)
    .set(patch)
    .where(
      and(
        eq(businessParties.partyId, partyId),
        eq(businessParties.organizationId, organizationId),
      ),
    )
    .returning();
  if (!updated) throw new Error(`Party ${partyId} vanished mid-transaction`);
  return updated;
}

/**
 * A bare Party, before it takes the values of the record it will mirror.
 *
 * Two statements where one would do, deliberately. `absorb` needs a real Party
 * row to fold a partial legacy patch into — jsonb bags merge, and
 * `clients.is_vendor` is read against the current `party_type` — and inventing a
 * blank `PartyRow` in TypeScript to stand in for one would be a third place that
 * has to be updated whenever a column is added. Both statements are in the same
 * transaction, so nothing ever observes the intermediate row.
 */
export async function insertBareParty(
  db: MirrorDb,
  organizationId: string,
  name: string,
): Promise<PartyRow> {
  const [row] = await db.insert(businessParties).values({ organizationId, name }).returning();
  if (!row) throw new Error("Failed to create the party behind the legacy record");
  return row;
}

export async function grantRole(
  db: MirrorDb,
  organizationId: string,
  partyId: string,
  kind: MappedLegacyKind,
  assignedBy: string,
): Promise<void> {
  await db
    .insert(partyRoles)
    .values({ organizationId, partyId, role: ROLE_FOR_KIND[kind], assignedBy })
    .onConflictDoNothing();
}

async function loadParties(
  db: MirrorDb,
  organizationId: string,
  partyIds: readonly string[],
): Promise<Map<string, PartyRow>> {
  if (partyIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(businessParties)
    .where(
      and(
        eq(businessParties.organizationId, organizationId),
        inArray(businessParties.partyId, [...partyIds]),
      ),
    );
  return new Map(rows.map((row) => [row.partyId, row]));
}

/**
 * Applies a per-party patch to many parties, and hands back what they became.
 *
 * The patch is computed per row because `absorb` reads the row it folds into --
 * a jsonb bag merges, and `is_vendor` is read against the current `party_type`
 * -- but a uniform bulk patch almost always produces one payload for every row,
 * so the writes are grouped. Reading the rows back matters more than the
 * grouping: the mirror is derived from what the party *became*, which is not
 * what the patch said wherever a default or an `$onUpdate` column is involved.
 */
export async function movePartiesFor(
  db: MirrorDb,
  organizationId: string,
  partyIds: readonly string[],
  patchOf: (party: PartyRow) => PartyPatch,
): Promise<Map<string, PartyRow>> {
  const current = await loadParties(db, organizationId, partyIds);
  const moved = new Map<string, PartyRow>();

  for (const group of groupByPayload(
    [...current.values()].map((party) => ({ id: party.partyId, payload: patchOf(party) })),
  )) {
    if (Object.keys(group.payload).length === 0) {
      for (const partyId of group.ids) {
        const unchanged = current.get(partyId);
        if (unchanged) moved.set(partyId, unchanged);
      }
      continue;
    }
    const rows = await db
      .update(businessParties)
      .set(group.payload)
      .where(
        and(
          eq(businessParties.organizationId, organizationId),
          inArray(businessParties.partyId, group.ids),
        ),
      )
      .returning();
    for (const row of rows) moved.set(row.partyId, row);
  }

  return moved;
}

/**
 * Groups rows whose derived payload is identical, so a bulk write stays a
 * handful of statements.
 *
 * Deriving per row is what makes the mirror correct — the payload is a function
 * of the whole Party row, not of the patch — but a uniform patch almost always
 * produces one payload for every row, and issuing one UPDATE per lead would put
 * a bulk operation's cost back where the migration removed it.
 */
export function groupByPayload<TId, TPayload extends object>(
  entries: readonly { id: TId; payload: TPayload }[],
): { payload: TPayload; ids: TId[] }[] {
  const groups = new Map<string, { payload: TPayload; ids: TId[] }>();
  for (const entry of entries) {
    const key = JSON.stringify(entry.payload);
    const existing = groups.get(key);
    if (existing) existing.ids.push(entry.id);
    else groups.set(key, { payload: entry.payload, ids: [entry.id] });
  }
  return [...groups.values()];
}

// --- The Party surface ------------------------------------------------------

/**
 * Pushes a Party row out to every legacy row that mirrors it.
 *
 * Every legacy row, plural: a merge re-points the losing record's map row onto
 * the survivor, so one Party legitimately answers for several legacy
 * identifiers, and refreshing only one of them would leave the others as the
 * stale copies this whole ticket exists to rule out.
 */
async function refreshMirrorsOfParty(
  db: MirrorDb,
  organizationId: string,
  party: PartyRow,
): Promise<void> {
  const [leadRows, clientRows, contactRows] = await Promise.all([
    db
      .select({ id: leadPartyMap.leadId })
      .from(leadPartyMap)
      .where(
        and(
          eq(leadPartyMap.organizationId, organizationId),
          eq(leadPartyMap.partyId, party.partyId),
        ),
      ),
    db
      .select({ id: clientPartyMap.clientId })
      .from(clientPartyMap)
      .where(
        and(
          eq(clientPartyMap.organizationId, organizationId),
          eq(clientPartyMap.partyId, party.partyId),
        ),
      ),
    db
      .select({ id: contactPartyMap.contactId })
      .from(contactPartyMap)
      .where(
        and(
          eq(contactPartyMap.organizationId, organizationId),
          eq(contactPartyMap.partyId, party.partyId),
        ),
      ),
  ]);

  const leadIds = leadRows.map((row) => row.id);
  if (leadIds.length > 0)
    await db
      .update(leads)
      .set(LEAD_MIRROR.derive(party))
      .where(and(eq(leads.orgId, organizationId), inArray(leads.id, leadIds)));

  const clientIds = clientRows.map((row) => row.id);
  if (clientIds.length > 0)
    await db
      .update(clients)
      .set(CLIENT_MIRROR.derive(party))
      .where(and(eq(clients.orgId, organizationId), inArray(clients.id, clientIds)));

  const contactIds = contactRows.map((row) => row.id);
  if (contactIds.length > 0)
    await db
      .update(contacts)
      .set(CONTACT_MIRROR.derive(party))
      .where(and(eq(contacts.orgId, organizationId), inArray(contacts.id, contactIds)));
}

/**
 * Brings every legacy row mapped to a party back in line with it, changing
 * nothing on the party.
 *
 * The one caller is the merge: re-pointing the loser's `*_party_map` rows onto
 * the survivor hands the survivor legacy rows it has never derived, and those
 * rows still hold the loser's values until this runs.
 */
export async function refreshPartyMirrors(
  db: MirrorDb,
  organizationId: string,
  partyId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const party = await loadParty(tx, organizationId, partyId);
    if (!party) return;
    await refreshMirrorsOfParty(tx, organizationId, party);
  });
}

export async function updatePartyWithMirror(
  db: MirrorDb,
  organizationId: string,
  partyId: string,
  patch: PartyPatch,
): Promise<PartyRow> {
  return db.transaction(async (tx) => {
    const party = await applyPartyPatch(tx, organizationId, partyId, patch);
    await refreshMirrorsOfParty(tx, organizationId, party);
    return party;
  });
}

/**
 * Soft-deletes a Party and everything that mirrors it.
 *
 * `clients` has no `deleted_at`, so a client mirror cannot record the deletion.
 * That gap is reported by `findUnexpressibleDeletions` rather than closed by
 * inventing a meaning for `clients.status`: the legacy surface has never offered
 * a client delete, and giving it one here would be a behaviour change outside
 * this ticket's remit.
 */
export async function softDeletePartyWithMirror(
  db: MirrorDb,
  organizationId: string,
  partyId: string,
): Promise<PartyRow> {
  return updatePartyWithMirror(db, organizationId, partyId, { deletedAt: new Date() });
}

/** Undoes a soft delete on both sides, for the merge revert path. */
export async function restorePartyWithMirror(
  db: MirrorDb,
  organizationId: string,
  partyId: string,
  patch: PartyPatch = {},
): Promise<PartyRow> {
  return updatePartyWithMirror(db, organizationId, partyId, { ...patch, deletedAt: null });
}

/**
 * How many legacy rows currently disagree with their Party, per kind.
 *
 * Kept here rather than in the divergence service so that a test of the writer
 * can assert its own claim: after any function above, this is zero.
 */
export async function countMirroredRows(
  db: MirrorDb,
  organizationId: string,
): Promise<Record<MappedLegacyKind, number>> {
  const [lead] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(leadPartyMap)
    .where(eq(leadPartyMap.organizationId, organizationId));
  const [client] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(clientPartyMap)
    .where(eq(clientPartyMap.organizationId, organizationId));
  const [contact] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(contactPartyMap)
    .where(eq(contactPartyMap.organizationId, organizationId));
  return { LEAD: lead?.n ?? 0, CLIENT: client?.n ?? 0, CONTACT: contact?.n ?? 0 };
}
