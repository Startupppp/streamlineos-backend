import { businessParties } from "../../db/schema/party";
import type { LegacyClientInsert, LegacyContactInsert, LegacyCrmOrgInsert, LegacyLeadInsert } from "./legacy-shapes";

/**
 * What every Party column means to `leads`, `clients` and `contacts`.
 *
 * The catalog half of the mirror: which legacy column each Party column
 * produces, how, and how the same columns fold back for a caller still holding a
 * legacy-shaped patch. `party-legacy-mirror.ts` is the engine that applies it,
 * and the only thing that ever should — nothing else derives a legacy row.
 *
 * The map is keyed by Party column and annotated `Record<keyof PartyRow, …>`, so
 * adding a column to `business_parties` fails to compile here until somebody
 * says where it lands. That is the guarantee that matters: a mirror drifts by
 * omission far more often than by disagreement, and omission is the half a
 * compiler can catch.
 *
 * Each cell is a pair. `derive` produces the legacy columns this Party column
 * owns — always all of them, nulls included, so the column set never depends on
 * the value. `absorb` folds those same columns back, so a write path that still
 * speaks `leads` does not have to learn Party's vocabulary at its call site.
 * `absorb` is the inverse of `derive`, declared beside it and round-tripped in
 * the spec; it is an input adapter, not a second mirror.
 *
 * The column names differ on purpose. `clients.gstin` is a tax number,
 * `leads.designation` and `contacts.title` are one job title, and
 * `leads.assigned_to_id` and `clients.account_manager_id` are one owner wearing
 * whichever label the lifecycle stage gave them. See 0240 for why the merged
 * model refused to carry three names for one field.
 */

export type PartyRow = typeof businessParties.$inferSelect;
export type PartyPatch = Partial<typeof businessParties.$inferInsert>;

/*
  Pointed at the written shapes, not at the tables. Ticket 08's contract.

  `legacy-shapes.spec.ts` proved these are structurally identical to what
  `$inferSelect` produced, while the tables still existed. That proof is why this
  swap changes nothing for any of the two dozen files that speak this
  vocabulary — and why it could only be made in this order.
*/
export type LeadInsert = LegacyLeadInsert;
export type ClientInsert = LegacyClientInsert;
export type ContactInsert = LegacyContactInsert;
export type CrmOrgInsert = LegacyCrmOrgInsert;

/**
 * One Party column's contribution to one legacy table.
 *
 * `derive` receives the whole Party row rather than just its own column because
 * a few legacy columns are a function of more than one Party field —
 * `clients.is_vendor` reads `party_type`, and the NOT NULL columns need a
 * fallback the Party side is allowed to leave null.
 */
export interface MirrorCell<TInsert> {
  readonly derive: (party: PartyRow) => Partial<TInsert>;
  readonly absorb: (legacy: Partial<TInsert>, current: PartyRow) => PartyPatch;
}

export interface MirrorTargets {
  readonly LEAD?: MirrorCell<LeadInsert>;
  readonly CLIENT?: MirrorCell<ClientInsert>;
  readonly CONTACT?: MirrorCell<ContactInsert>;
  readonly ORGANISATION?: MirrorCell<CrmOrgInsert>;
}

/**
 * At least one target, or a reason there is none.
 *
 * Without this an entry could be spelled `{}` — present in the map, mapped
 * nowhere, and indistinguishable from a deliberate decision. The whole point of
 * the map is that every Party column has been thought about once.
 */
type AtLeastOneTarget = {
  [K in keyof MirrorTargets]-?: Required<Pick<MirrorTargets, K>> & Partial<Omit<MirrorTargets, K>>;
}[keyof MirrorTargets];

export type PartyFieldMirror = AtLeastOneTarget | { readonly legacyHasNoColumn: string };

export const noLegacyColumn = (because: string): PartyFieldMirror => ({ legacyHasNoColumn: because });

/** A row as Postgres hands it back, before anything knows which table it is. */
export type ErasedRow = Record<string, unknown>;

/**
 * Sets, clears or leaves one key of a Party jsonb bag.
 *
 * `undefined` means the legacy patch did not mention the column, so the bag is
 * untouched; `null` means it was explicitly cleared. An empty bag becomes null
 * rather than `{}`, matching what 0241's `NULLIF(jsonb_strip_nulls(...))` left
 * behind, so a round trip through here does not turn a null column into an empty
 * object and report itself as divergence forever.
 */
export function withKey(
  bag: Record<string, string> | null,
  key: string,
  value: string | null | undefined,
): Record<string, string> | null {
  if (value === undefined) return bag;
  const next: Record<string, string> = { ...bag };
  if (value === null) delete next[key];
  else next[key] = value;
  return Object.keys(next).length === 0 ? null : next;
}
