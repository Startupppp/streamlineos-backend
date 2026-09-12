import { and, eq, inArray } from "drizzle-orm";
import { crmOrgPartyMap } from "../../db/schema/party";
import { ORGANISATION_MIRROR } from "./party-legacy-mirror";
import type { PartyRow } from "./party-mirror-fields";
import {
  type CrmOrgInsert,
  type CrmOrgRow,
  type MirrorDb,
} from "./party-legacy-writer";
import { parentColumnOf } from "./party-legacy-associations";

export async function partyIdsForOrganisations(
  db: MirrorDb,
  organizationId: string,
  crmOrganizationIds: readonly number[],
): Promise<Map<number, string>> {
  const rows = await db
    .select({
      crmOrganizationId: crmOrgPartyMap.crmOrganizationId,
      partyId: crmOrgPartyMap.partyId,
    })
    .from(crmOrgPartyMap)
    .where(
      and(
        eq(crmOrgPartyMap.organizationId, organizationId),
        inArray(crmOrgPartyMap.crmOrganizationId, [...crmOrganizationIds]),
      ),
    );
  return new Map(rows.map((row) => [row.crmOrganizationId, row.partyId]));
}

/**
 * A company row, assembled from the Party it mirrors.
 *
 * The values come from `ORGANISATION_MIRROR.derive` and nowhere else -- the same
 * derivation that used to be handed to `insert(crmOrganizations)`. What the table
 * contributed on top was the serial and two timestamps, and Party carries both
 * timestamps already.
 *
 * Async, unlike its `leads` counterpart, because `parent_id` crosses id spaces
 * and resolving it is a read of `crm_org_party_map`. The order of the spreads is
 * the order the `insert`/`update` payload used before ticket 08, and it is
 * load-bearing: a caller's explicit `parentId` still wins over the one derived
 * from `parent_party_id`, exactly as `.returning()` used to report it.
 *
 * The `??` arms narrow `Partial<CrmOrgInsert>` to the NOT NULL shape; they do not
 * decide it. The derivation is total over every column it owns, which the mirror
 * spec asserts separately.
 */
export async function legacyOrganisationRow(
  db: MirrorDb,
  crmOrganizationId: number,
  organizationId: string,
  party: PartyRow,
  legacyOwnedPatch: Partial<CrmOrgInsert>,
): Promise<CrmOrgRow> {
  const derived = ORGANISATION_MIRROR.derive(party);

  return {
    ...derived,
    ...(await parentColumnOf(db, organizationId, party.parentPartyId)),
    ...legacyOwnedPatch,
    id: crmOrganizationId,
    orgId: organizationId,
    name: derived.name ?? party.name,
    /**
     * Null unless the caller named one, which nothing does.
     *
     * `merged_into_id` was the legacy merge pointer, and `PartyMergeService` is
     * the merge this codebase has: it re-points the loser's `crm_org_party_map`
     * row onto the survivor and snapshots the rest, so the column stopped being
     * written before this ticket (see `crm-organizations.service.ts`). It is
     * stated here rather than left off so the shape stays total -- a consumer
     * reading `row.mergedIntoId` gets the null it always got, not `undefined`.
     */
    mergedIntoId: legacyOwnedPatch.mergedIntoId ?? null,
    createdAt: party.createdAt,
    updatedAt: party.updatedAt,
    deletedAt: party.deletedAt,
  } as CrmOrgRow;
}
