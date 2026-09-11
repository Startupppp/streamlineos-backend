import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/drizzle.types";
import {
  businessParties,
  clientPartyMap,
  contactPartyMap,
  crmOrgPartyMap,
  leadPartyMap,
  partyIdentifiers,
  partyRoles,
} from "../../db/schema/party";
import { type PartyPatch, type PartyRow } from "./party-legacy-mirror";
import type { MappedLegacyKind } from "./party-legacy-seam";
import { normaliseIdentifier } from "../ingress/inbound-event";
import { claimIdentifiers, claimsOfPatch, identifierClaimsOfColumns } from "./party-identifiers";

/**
 * The Party surface itself: read, patch, insert, mint an id, grant a role, move
 * a set of parties between organisations.
 *
 * Split out of `party-legacy-writer.ts` for the 500-line limit, and the split
 * runs along a line that already existed. Nothing in this file touches `leads`,
 * `clients`, `contacts` or `crm_organizations` — every one of those references
 * stayed next door with `refreshMirrorsOfParty`. That is load-bearing, not
 * incidental: `legacy-reader-ratchet.spec.ts` holds a list of files reading the
 * legacy identity tables which "may only shrink", so a split that put a legacy
 * import in a NEW file would have had to grow it, and the ratchet says in as
 * many words that this may not happen again. `party-legacy-writer.ts` re-exports
 * everything here, so no caller moved either.
 */

/**
 * A Drizzle handle: the tenant-aware `this.db`, or a transaction a caller
 * already opened. Both accept the four verbs used below.
 */
export type MirrorDb = Db;


/**
 * What 0241 gave the backfilled rows; new rows get the same, for the same reason.
 *
 * `ORGANISATION` gets none, and the null is the decision rather than an omission.
 * A `party_roles` row says what a party is *to us* — prospect, customer, vendor
 * — and a company record says no such thing: `crm_organizations` is a company
 * that exists, not a relationship we have with it. The CUSTOMER role arrives with
 * a deal or an invoice, from whichever module records that. Granting one here
 * would put every company anybody ever typed into the customer list.
 */
const ROLE_FOR_KIND: Record<MappedLegacyKind, string | null> = {
  LEAD: "PROSPECT",
  CLIENT: "CUSTOMER",
  CONTACT: "CONTACT",
  ORGANISATION: null,
};

export interface MirrorWriteOptions {
  /** Recorded on the map row: a user id, or the job that linked the two. */
  readonly linkedBy?: string;
}

export async function loadParty(
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

  /**
   * The contact columns claimed as identifiers, in the caller's transaction.
   *
   * 0260 backfilled every address that existed when it ran. Without this the
   * backfill would be a snapshot: a lead created or edited afterwards would
   * carry an email address that `resolve-party` cannot match, so the next
   * message from that customer would create a second record — a migration that
   * improved the past and broke the present.
   *
   * Gated on the patch rather than on the row so that a write touching neither
   * an address nor a number costs nothing, which is almost all of them.
   */
  if (claimsOfPatch(patch) !== null)
    await claimIdentifiers(db, organizationId, partyId, identifierClaimsOfColumns(updated));

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

/**
 * The identifier a legacy record is known by, minted without the legacy table.
 *
 * Ticket 08's contract. `leads.id` and its siblings are serial integers, and
 * they are the CRM's **public** identifiers -- they sit in `GET /leads/:leadId`
 * behind a `ParseIntPipe` and in `/crm/leads/[leadId]` in the address bar.
 * Party's identifier is a UUID, so dropping the tables naively would rename
 * every record in the product and break every link anybody has saved.
 *
 * Migration 0277 moved the minting to the map: each `*_party_map` now defaults
 * its integer column from the sequence the legacy table used to own, detached
 * with `OWNED BY NONE` so `DROP TABLE` cannot take it. Numbering continues
 * unbroken, and a record keeps the name it already had.
 *
 * So this inserts the map row and lets the database hand back the number, rather
 * than inserting a legacy row to find out what the number would have been.
 */
export async function mintLegacyId(
  db: MirrorDb,
  organizationId: string,
  partyId: string,
  kind: MappedLegacyKind,
  linkedBy: string,
): Promise<number> {
  switch (kind) {
    case "LEAD": {
      const [row] = await db
        .insert(leadPartyMap)
        .values({ organizationId, partyId, linkedBy })
        .returning({ id: leadPartyMap.leadId });
      if (!row) throw new Error("Failed to mint a lead identifier");
      return row.id;
    }
    case "CLIENT": {
      const [row] = await db
        .insert(clientPartyMap)
        .values({ organizationId, partyId, linkedBy })
        .returning({ id: clientPartyMap.clientId });
      if (!row) throw new Error("Failed to mint a client identifier");
      return row.id;
    }
    case "CONTACT": {
      const [row] = await db
        .insert(contactPartyMap)
        .values({ organizationId, partyId, linkedBy })
        .returning({ id: contactPartyMap.contactId });
      if (!row) throw new Error("Failed to mint a contact identifier");
      return row.id;
    }
    case "ORGANISATION": {
      const [row] = await db
        .insert(crmOrgPartyMap)
        .values({ organizationId, partyId, linkedBy })
        .returning({ id: crmOrgPartyMap.crmOrganizationId });
      if (!row) throw new Error("Failed to mint an organisation identifier");
      return row.id;
    }
  }
}

export async function grantRole(
  db: MirrorDb,
  organizationId: string,
  partyId: string,
  kind: MappedLegacyKind,
  assignedBy: string,
): Promise<void> {
  const role = ROLE_FOR_KIND[kind];
  if (!role) return;
  await db
    .insert(partyRoles)
    .values({ organizationId, partyId, role, assignedBy })
    .onConflictDoNothing();
}

export async function loadParties(
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

    // The same claim `applyPartyPatch` makes, for the bulk path that does not
    // go through it. Gated on the payload, so the ownership and stage sweeps
    // that make up nearly every bulk write cost nothing extra.
    if (claimsOfPatch(group.payload) !== null)
      await claimIdentifiersOfParties(db, organizationId, rows);
  }

  return moved;
}

/**
 * `claimIdentifiers` for a whole group of moved parties, in one statement.
 *
 * The loop this replaces claimed each party's addresses with its own INSERT, so
 * a bulk ownership or stage sweep that happened to touch a contact column cost
 * one round trip per party. The rows are the same ones `claimIdentifiers` would
 * write, normalised and de-duplicated the same way, and a claim that already
 * exists is left alone exactly as it was.
 */
async function claimIdentifiersOfParties(
  db: MirrorDb,
  organizationId: string,
  parties: readonly PartyRow[],
): Promise<void> {
  const rows: (typeof partyIdentifiers.$inferInsert)[] = [];
  const seen = new Set<string>();
  for (const party of parties) {
    for (const claim of identifierClaimsOfColumns(party)) {
      const normalisedValue = normaliseIdentifier(claim.kind, claim.value);
      const key = `${claim.kind}:${normalisedValue}`;
      if (!normalisedValue || seen.has(key)) continue;
      seen.add(key);
      const value = claim.value.trim();
      rows.push({ organizationId, partyId: party.partyId, kind: claim.kind, value, normalisedValue });
    }
  }
  if (rows.length === 0) return;
  await db.insert(partyIdentifiers).values(rows).onConflictDoNothing();
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
