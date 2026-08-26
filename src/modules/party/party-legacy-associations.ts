import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/drizzle.types";
import { leadPartyMap } from "../../db/schema/party";
import { partyIdsOfCrmOrgs, crmOrgIdsOfParties } from "./party-legacy-employer";
import type { PartyPatch } from "./party-mirror-fields";

/**
 * The two remaining translations between a Party link and the column that held it.
 *
 * `party-legacy-employer.ts` is the pattern and the argument; this is the same
 * shape for the two associations 0265 added that cross an id space:
 *
 *   `converted_from_party_id`  ↔  `clients.lead_id` and `contacts.lead_id`
 *   `parent_party_id`          ↔  `crm_organizations.parent_id`
 *
 * Both are party ids on one side and integer legacy ids on the other, so getting
 * between them means reading a `*_party_map` table — a query. Every cell in
 * `party-mirror-fields.ts` is a pure function of one row, deliberately: it is
 * what lets the divergence sweep re-run the derivation offline and diff it
 * against disk. A cell that needed a database would either break that property
 * or quietly become a second mapper, and the phase has exactly one. So the
 * translation lives out here and the writer calls it on both sides of every
 * write, exactly as it does for the employer.
 *
 * `contacts.deal_id` is deliberately NOT here. It and `primary_deal_id` are the
 * same integer `deals` id in the same id space, so it stays a pure `MirrorCell`
 * rather than joining these two out of symmetry — a translation that translates
 * nothing is a place for a bug to hide.
 *
 * The parent half re-uses `party-legacy-employer.ts`'s `crm_org_party_map`
 * readers rather than declaring a second pair against the same table. The
 * hierarchy and the employer link ask the same question of that map — "which
 * company is this party" and "which party is this company" — and answering it
 * twice is how the two answers start disagreeing after a merge.
 *
 * Plain functions taking `db`, matching `party-legacy-seam.ts` and the writer
 * beside it. Both directions re-assert `organizationId` rather than leaning on
 * RLS, for the same reason the seam does: a legacy id belonging to another
 * tenant must translate to nothing rather than to somebody else's record.
 */

/** The lead id each of these parties is registered as, where it is one. */
export async function leadIdsOfParties(
  db: Db,
  organizationId: string,
  partyIds: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  const resolved = new Map<string, number>();
  const ids = [...new Set(partyIds)].filter((id) => id.length > 0);
  if (!organizationId || ids.length === 0) return resolved;

  const rows = await db
    .select({ partyId: leadPartyMap.partyId, leadId: leadPartyMap.leadId })
    .from(leadPartyMap)
    .where(
      and(eq(leadPartyMap.organizationId, organizationId), inArray(leadPartyMap.partyId, ids)),
    );

  /*
   * Lowest id wins where a party answers to several, which happens after a merge
   * re-points the loser's map row onto the survivor. Any of them is a correct
   * answer to "which lead is this"; picking deterministically is what stops the
   * mirror flapping between two of them on consecutive writes and reporting
   * itself as divergent forever. Same rule as `crmOrgIdsOfParties`, and it has to
   * be the same rule or the two would disagree about the same merge.
   */
  for (const row of rows) {
    const existing = resolved.get(row.partyId);
    if (existing === undefined || row.leadId < existing) resolved.set(row.partyId, row.leadId);
  }
  return resolved;
}

/** The party behind each of these lead ids. */
export async function partyIdsOfLeads(
  db: Db,
  organizationId: string,
  leadIds: readonly number[],
): Promise<ReadonlyMap<number, string>> {
  const resolved = new Map<number, string>();
  const ids = [...new Set(leadIds)].filter((id) => Number.isInteger(id));
  if (!organizationId || ids.length === 0) return resolved;

  const rows = await db
    .select({ leadId: leadPartyMap.leadId, partyId: leadPartyMap.partyId })
    .from(leadPartyMap)
    .where(
      and(eq(leadPartyMap.organizationId, organizationId), inArray(leadPartyMap.leadId, ids)),
    );

  for (const row of rows) resolved.set(row.leadId, row.partyId);
  return resolved;
}

/**
 * `lead_id` → the `converted_from_party_id` it means.
 *
 * `undefined` in, `undefined` out: a patch that never mentioned the lead must not
 * clear one. An explicit `null` clears it. A number that resolves to nothing
 * throws rather than silently clearing, because "the lead you named does not
 * exist here" and "this record came from no lead" are different answers and only
 * one of them is a request.
 *
 * Says nothing about whether the answer is the party being patched; that is
 * `withoutSelfLinks`, applied where the patch lands. Separated because this half
 * needs a database and that half does not, and a bulk write reads the map once
 * for fifty parties whose self-check is fifty different questions.
 */
export async function absorbLeadColumn(
  db: Db,
  organizationId: string,
  legacyLeadId: number | null | undefined,
): Promise<{ convertedFromPartyId?: string | null }> {
  if (legacyLeadId === undefined) return {};
  if (legacyLeadId === null) return { convertedFromPartyId: null };

  const resolved = await partyIdsOfLeads(db, organizationId, [legacyLeadId]);
  const leadPartyId = resolved.get(legacyLeadId);
  if (!leadPartyId)
    throw new Error(
      `Lead ${legacyLeadId} has no party in this tenant; run the 0241 backfill before converting from it`,
    );
  return { convertedFromPartyId: leadPartyId };
}

/**
 * `parent_id` → the `parent_party_id` it means.
 *
 * The company half of `absorbLeadColumn`, with the same three cases and the same
 * split against `withoutSelfLinks`.
 */
export async function absorbParentColumn(
  db: Db,
  organizationId: string,
  legacyParentId: number | null | undefined,
): Promise<{ parentPartyId?: string | null }> {
  if (legacyParentId === undefined) return {};
  if (legacyParentId === null) return { parentPartyId: null };

  const resolved = await partyIdsOfCrmOrgs(db, organizationId, [legacyParentId]);
  const parentPartyId = resolved.get(legacyParentId);
  if (!parentPartyId)
    throw new Error(
      `Organization ${legacyParentId} has no party in this tenant; run the 0264 backfill before parenting to it`,
    );
  return { parentPartyId };
}

/**
 * Drops a link that points at the party carrying it.
 *
 * Reachable, not hypothetical. A merge re-points the losing record's map row onto
 * the survivor, so after one a single party legitimately answers to a client id
 * AND to the lead id that client was converted from — which is exactly the pair
 * 0241 named as merge candidates. Storing the link would violate the CHECKs from
 * 0265 and abort the write; "this record came from itself" is not a fact worth
 * failing a write over, so the link is dropped and the record keeps its identity.
 *
 * Pure, and applied where the patch lands rather than where it is resolved: the
 * resolution needs a database and this does not, and a bulk patch resolves once
 * for fifty parties whose self-check is fifty different questions. 0266 makes the
 * same decision in SQL, as `<> p.party_id` on both links.
 *
 * `employerPartyId` is covered too, though nothing in this file sets it: the
 * CHECK it would violate is the same shape and predates these two, and a party
 * whose employer is itself is representable through `absorbEmployerColumn` today.
 */
export function withoutSelfLinks<T extends PartyPatch>(patch: T, partyId: string): T {
  const cleaned = { ...patch };
  for (const key of ["convertedFromPartyId", "parentPartyId", "employerPartyId"] as const)
    if (cleaned[key] === partyId) cleaned[key] = null;
  return cleaned;
}

/**
 * `converted_from_party_id` → the `lead_id` that mirrors it.
 *
 * A whole column rather than a conditional, for the reason `employerColumnOf`
 * gives: a party converted from nothing must write `null`, not nothing, or
 * clearing the link would silently leave the old one on the legacy row.
 *
 * Null also where the source is a party with no `leads` row behind it — a lead
 * created directly on the Party surface, say. That second null is a real loss of
 * information rather than an absence, and it is the same loss
 * `findEmployerDisagreements` reports for the employer: the legacy column cannot
 * name a record the legacy table has never heard of, and inventing a `leads` row
 * to make it representable would be the mirror writing identity rather than
 * copying it.
 */
export async function convertedFromColumnOf(
  db: Db,
  organizationId: string,
  convertedFromPartyId: string | null,
): Promise<{ leadId: number | null }> {
  if (!convertedFromPartyId) return { leadId: null };
  const legacy = await leadIdsOfParties(db, organizationId, [convertedFromPartyId]);
  return { leadId: legacy.get(convertedFromPartyId) ?? null };
}

/** `parent_party_id` → the `crm_organizations.parent_id` that mirrors it. */
export async function parentColumnOf(
  db: Db,
  organizationId: string,
  parentPartyId: string | null,
): Promise<{ parentId: number | null }> {
  if (!parentPartyId) return { parentId: null };
  const legacy = await crmOrgIdsOfParties(db, organizationId, [parentPartyId]);
  return { parentId: legacy.get(parentPartyId) ?? null };
}
