import type { LegacyClientInsert, LegacyClientRow, LegacyContactInsert, LegacyContactRow, LegacyCrmOrgInsert, LegacyCrmOrgRow, LegacyLeadInsert, LegacyLeadRow } from "./legacy-shapes";
import { type PartyPatch, type PartyRow } from "./party-legacy-mirror";
import { applyPartyPatch, loadParty, type MirrorDb } from "./party-write-primitives";
import { employerLegacyIds } from "./party-legacy-employer";

/**
 * The shared half of the Party-first write, and the Party surface itself.
 *
 * Party is canonical from this ticket onward. That is a decision, not a
 * mechanism: the legacy-SHAPED write keeps happening so unmigrated modules keep
 * working, but nothing reads it as truth again, which turns a disagreement from
 * "two sources, pick one" into "the mirror is stale".
 *
 * The legacy tables themselves are gone. `leads`, `clients`, `contacts` and
 * `crm_organizations` were dropped by phase 2 ticket 08 and no `pgTable` for
 * them exists anywhere in `src/db/schema/`; what this file writes is the Party
 * row and its `*PartyMap` entry, which is the whole import list above. The
 * sentence that used to stand here said the old tables "keep taking writes",
 * which was true when it was written and had been false since the drop —
 * corrected rather than deleted because the distinction it draws is the point
 * of the file. Every function here
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
 * Re-exported so every module importing these from here is untouched by the
 * split, and so this file stays the one Party-write surface to import.
 *
 * `loadParty` and `loadParties` are deliberately NOT re-exported: they were
 * module-private before the split and stay that way from the outside. They
 * carry `export` next door only because this file needs them.
 */
export {
  applyPartyPatch,
  grantRole,
  insertBareParty,
  mintLegacyId,
  movePartiesFor,
  type MirrorDb,
  type MirrorWriteOptions,
} from "./party-write-primitives";

/*
  Pointed at the written shapes, not at the tables. Ticket 08's contract.

  `legacy-shapes.spec.ts` proved these are structurally identical to what
  `$inferSelect` produced, while the tables still existed. That proof is why this
  swap changes nothing for any of the two dozen files that speak this
  vocabulary — and why it could only be made in this order.
*/
export type LeadRow = LegacyLeadRow;
export type ClientRow = LegacyClientRow;
export type ContactRow = LegacyContactRow;
export type LeadInsert = LegacyLeadInsert;
export type ClientInsert = LegacyClientInsert;
export type ContactInsert = LegacyContactInsert;
export type CrmOrgRow = LegacyCrmOrgRow;
export type CrmOrgInsert = LegacyCrmOrgInsert;

// --- The Party surface ------------------------------------------------------

/**
 * The `contacts.organization_id` this party's employer means, as a patch.
 *
 * A whole column rather than a conditional: a party with no employer must write
 * `null`, not nothing, or clearing an employer would silently leave the old one
 * on the legacy row — which is the exact shape of stale the mirror exists to
 * rule out.
 */
export async function employerColumnOf(
  db: MirrorDb,
  organizationId: string,
  party: PartyRow,
): Promise<{ organizationId: number | null }> {
  if (!party.employerPartyId) return { organizationId: null };
  const legacy = await employerLegacyIds(db, organizationId, [party.employerPartyId]);
  return { organizationId: legacy.get(party.employerPartyId) ?? null };
}

/**
 * Kept as a no-op so the merge path reads honestly.
 *
 * Ticket 08's contract. This used to bring every legacy row mapped to a party
 * back in line with it, because re-pointing the loser's `*_party_map` rows onto
 * the survivor handed the survivor rows it had never derived, still holding the
 * loser's values.
 *
 * There is no second copy any more. A legacy shape is **computed** from the
 * party at the moment it is read, so re-pointing a map row is already the whole
 * of the merge: the next read derives from the survivor because the map says it
 * should. Nothing can be stale, because nothing is stored.
 *
 * Kept rather than deleted, and deliberately: `party-merge.service.ts` calls it
 * at the point where the mirror used to need catching up, and that call site is
 * a true statement about the sequence even now. Removing it would make a future
 * reader wonder whether the merge forgot a step.
 */
export async function refreshPartyMirrors(
  _db: MirrorDb,
  _organizationId: string,
  _partyId: string,
): Promise<void> {
  return Promise.resolve();
}

export async function updatePartyWithMirror(
  db: MirrorDb,
  organizationId: string,
  partyId: string,
  patch: PartyPatch,
): Promise<PartyRow> {
  return db.transaction(async (tx) => {
    // No mirror to refresh: the legacy shapes are derived on read, so writing
    // the party IS writing them. Ticket 08.
    return applyPartyPatch(tx, organizationId, partyId, patch);
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
