import { and, eq, inArray, isNull } from "drizzle-orm";
import { businessParties, crmOrgPartyMap } from "../../db/schema/party";
import { ORGANISATION_MIRROR } from "./party-legacy-mirror";
import {
  movePartiesFor,
  type CrmOrgInsert,
  type CrmOrgRow,
  type MirrorDb,
} from "./party-legacy-writer";
import {
  absorbParentColumn,
  withoutSelfLinks,
} from "./party-legacy-associations";
import { partyIdsForOrganisations, legacyOrganisationRow } from "./party-legacy-orgs-helpers";

export async function updateMirroredOrganizations(
  db: MirrorDb,
  organizationId: string,
  crmOrganizationIds: readonly number[],
  patch: Partial<CrmOrgInsert>,
): Promise<CrmOrgRow[]> {
  const ids = [...new Set(crmOrganizationIds)].filter((id) => Number.isInteger(id));
  if (ids.length === 0) return [];

  return db.transaction(async (tx) => {
    const partyByOrg = await partyIdsForOrganisations(tx, organizationId, ids);

    /*
     * Resolved once, outside the per-party derivation: which parent the caller
     * named is a property of the patch, not of whichever company is being
     * patched, and `reparentSubsidiaries` moves every child of a merged company
     * in one call. The self-check is not a property of the patch, so it stays
     * inside -- and it is the one that matters here, because re-parenting the
     * children of a loser onto the survivor can hand a company itself.
     */
    const parentPatch = await absorbParentColumn(tx, organizationId, patch.parentId);

    const moved = await movePartiesFor(
      tx,
      organizationId,
      [...new Set(partyByOrg.values())],
      (party) =>
        withoutSelfLinks(
          { ...ORGANISATION_MIRROR.split(patch, party).partyPatch, ...parentPatch },
          party.partyId,
        ),
    );

    /*
     * One assembled row per company that moved, in place of the grouped
     * `UPDATE ... RETURNING` this used to issue. The grouping existed to keep a
     * bulk write to a handful of statements; the statements it grouped are gone,
     * and `movePartiesFor` still groups the Party writes, which are the only
     * writes left. What is returned is what the party *became*, which is what
     * `.returning()` reported too -- the mirror was always derived from the moved
     * row rather than from the patch.
     */
    const updated: CrmOrgRow[] = [];
    for (const [crmOrganizationId, partyId] of partyByOrg) {
      const party = moved.get(partyId);
      if (!party) continue;
      // The pass-through half does not depend on the party, so it is the same
      // for every row; the derivation is not, and is computed per party.
      const { legacyOwnedPatch } = ORGANISATION_MIRROR.split(patch, party);
      updated.push(
        await legacyOrganisationRow(tx, crmOrganizationId, organizationId, party, legacyOwnedPatch),
      );
    }
    return updated;
  });
}

export async function updateMirroredOrganization(
  db: MirrorDb,
  organizationId: string,
  crmOrganizationId: number,
  patch: Partial<CrmOrgInsert>,
): Promise<CrmOrgRow | undefined> {
  const [row] = await updateMirroredOrganizations(db, organizationId, [crmOrganizationId], patch);
  return row;
}

/**
 * Idempotent, for the reason recorded on `softDeleteMirroredLeads`: deleting an
 * already-deleted record must not move the timestamp that says when it went.
 *
 * Liveness is asked of the Party now rather than of `crm_organizations.deleted_at`
 * — the same question, of the column the legacy one was derived from, and the one
 * that still has an answer after the drop. The map row stays either way: it is
 * the record of what this company is *called*, and deleting it would orphan an
 * identifier that is still in URLs, in FKs and in every other module's copy of
 * the number.
 *
 * One consequence, recorded rather than hidden: an unmapped legacy row is no
 * longer adopted on the delete path, because the join that finds live companies
 * starts from the map. It is still adopted on the update path, where a caller is
 * changing values that must not be lost. A delete of a row the 0264 backfill
 * never saw now reports nothing deleted instead of adopting it in order to mark
 * it deleted — which is the direction that survives the table going away.
 */
export async function softDeleteMirroredOrganizations(
  db: MirrorDb,
  organizationId: string,
  crmOrganizationIds: readonly number[],
): Promise<CrmOrgRow[]> {
  const ids = [...new Set(crmOrganizationIds)].filter((id) => Number.isInteger(id));
  if (ids.length === 0) return [];
  const live = await db
    .select({ crmOrganizationId: crmOrgPartyMap.crmOrganizationId })
    .from(crmOrgPartyMap)
    .innerJoin(
      businessParties,
      and(
        eq(businessParties.partyId, crmOrgPartyMap.partyId),
        eq(businessParties.organizationId, crmOrgPartyMap.organizationId),
      ),
    )
    .where(
      and(
        eq(crmOrgPartyMap.organizationId, organizationId),
        inArray(crmOrgPartyMap.crmOrganizationId, ids),
        isNull(businessParties.deletedAt),
      ),
    );
  return updateMirroredOrganizations(
    db,
    organizationId,
    live.map((row) => row.crmOrganizationId),
    { deletedAt: new Date() },
  );
}
