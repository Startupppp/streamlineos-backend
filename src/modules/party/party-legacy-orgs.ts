import { and, eq, inArray, isNull } from "drizzle-orm";
import { businessParties, crmOrgPartyMap } from "../../db/schema/party";
import { crmOrganizations } from "../../db/schema/crm/contacts";
import { ORGANISATION_MIRROR } from "./party-legacy-mirror";
import type { PartyRow } from "./party-mirror-fields";
import {
  absorbParentColumn,
  parentColumnOf,
  withoutSelfLinks,
} from "./party-legacy-associations";
import {
  applyPartyPatch,
  grantRole,
  insertBareParty,
  mintLegacyId,
  movePartiesFor,
  type CrmOrgInsert,
  type CrmOrgRow,
  type MirrorDb,
  type MirrorWriteOptions,
} from "./party-legacy-writer";

/**
 * The `crm_organizations` entry points, Party-first — and, from ticket 08, Party-only.
 *
 * The fourth of these files and the last one the phase discovered it needed.
 * `crm_organizations` was never counted as an identity table — the split was
 * meant to be `contacts`, `clients`, `leads` and Party — but it carries a name, a
 * domain, an industry, a health score, a parent pointer, a merge pointer and its
 * own merge service, which is Party built a second time. Ticket 25 converged it,
 * and this is where its writes go from here.
 *
 * Ticket 08 drops the table, so nothing below reads or writes it. The rows these
 * functions return are **assembled** from the Party they mirror, by
 * `legacyOrganisationRow`, using the same `ORGANISATION_MIRROR.derive` that used
 * to be handed to `insert(crmOrganizations)`. That is why this is a contract
 * change rather than a behaviour change: the values were already derived from the
 * Party, and the table's only unique contribution was its serial. Migration 0277
 * moved the serial to `crm_org_party_map`, whose `crm_organization_id` now
 * defaults from the sequence `crm_organizations` used to own, detached with
 * `OWNED BY NONE` so `DROP TABLE` cannot take it — numbering continues unbroken
 * and every `/crm/organizations/[organizationId]` link anybody saved still opens
 * the same company.
 *
 * The one difference from its three siblings: a company gets no `party_roles`
 * row. See `ROLE_FOR_KIND` in the writer for why — the call below is still made,
 * so that the decision lives in one place rather than in an omission here.
 *
 * One column does not go through the field map. `crm_organizations.parent_id` is
 * an integer company id and its Party counterpart `parent_party_id` is a party
 * id, so translating needs `crm_org_party_map` and therefore a query — which a
 * `MirrorCell` deliberately cannot do. Both directions run through
 * `party-legacy-associations.ts`: `absorbParentColumn` where a caller's
 * `parentId` goes in, `parentColumnOf` where the assembled row hands one back,
 * and nowhere else. Ticket 25 left the hierarchy on the legacy row and said
 * converging it was the follow-up; 0265 is that follow-up, and 08 is where the
 * row it lived on stops existing.
 *
 * `adoptOrganisation` below is the one thing here that still reads
 * `crm_organizations`, and it is the last one in this file. It cannot be
 * converted, because it exists precisely for a row the Party side has never
 * heard of: there is nothing on the Party side to read instead. It goes when the
 * table does — `legacy-reader-ratchet.spec.ts` is the register that tracks it
 * until then — and at that point an id absent from `crm_org_party_map` names
 * nothing and is skipped rather than conjured, which is what these functions
 * already do when adoption finds no row.
 */

async function partyIdsForOrganisations(
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
 * Gives a company row that predates the backfill a Party, on first write.
 *
 * The same adoption path the other three kinds have: a row restored from a
 * backup, or imported out of band, still has to be writable, and failing the
 * write because the migration has not seen it would make the mirror the thing
 * standing between a user and their own data.
 *
 * The one read of `crm_organizations` ticket 08 leaves standing, and it is not a
 * mirror write: it reads a legacy row as truth exactly once, which is correct
 * precisely because there is no Party to contradict it. Nothing on the Party side
 * can stand in for it, so it goes when the table goes, not before.
 */
async function adoptOrganisation(
  db: MirrorDb,
  organizationId: string,
  crmOrganizationId: number,
): Promise<string | null> {
  const [row] = await db
    .select()
    .from(crmOrganizations)
    .where(
      and(eq(crmOrganizations.id, crmOrganizationId), eq(crmOrganizations.orgId, organizationId)),
    )
    .limit(1);
  if (!row) return null;

  const party = await insertBareParty(db, organizationId, row.name);
  const { partyPatch } = ORGANISATION_MIRROR.split(row, party);
  await applyPartyPatch(
    db,
    organizationId,
    party.partyId,
    withoutSelfLinks(
      {
        ...partyPatch,
        partyKind: "ORGANISATION",
        ...(await absorbParentColumn(db, organizationId, row.parentId)),
      },
      party.partyId,
    ),
  );
  await db
    .insert(crmOrgPartyMap)
    .values({
      organizationId,
      crmOrganizationId,
      partyId: party.partyId,
      linkedBy: "mirror:adopt",
    })
    .onConflictDoNothing();
  await grantRole(db, organizationId, party.partyId, "ORGANISATION", "mirror:adopt");
  return party.partyId;
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
async function legacyOrganisationRow(
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

export async function createMirroredOrganization(
  db: MirrorDb,
  organizationId: string,
  values: CrmOrgInsert,
  options: MirrorWriteOptions = {},
): Promise<CrmOrgRow> {
  return db.transaction(async (tx) => {
    const bare = await insertBareParty(tx, organizationId, values.name);
    const { partyPatch, legacyOwnedPatch } = ORGANISATION_MIRROR.split(values, bare);
    // `partyKind` has no legacy column to come from: every row in this table is a
    // company by construction, which is a fact about the table rather than about
    // any column on it, so the writer states it instead of deriving it.
    const party = await applyPartyPatch(
      tx,
      organizationId,
      bare.partyId,
      withoutSelfLinks(
        {
          ...partyPatch,
          partyKind: "ORGANISATION",
          ...(await absorbParentColumn(tx, organizationId, values.parentId)),
        },
        bare.partyId,
      ),
    );

    /**
     * The identifier comes from the map now, not from a `crm_organizations` insert.
     *
     * Ticket 08's contract, and the same move `createMirroredLead` makes. The row
     * this used to write was already **derived** from the Party --
     * `ORGANISATION_MIRROR.derive(party)` produced every mirrored column and the
     * table only added the serial and its timestamps -- so the table contributed
     * one thing that mattered: the number. 0277 moved the minting to
     * `crm_org_party_map`, and the shape below is assembled from the same
     * derivation that would have been written.
     */
    const crmOrganizationId = await mintLegacyId(
      tx,
      organizationId,
      party.partyId,
      "ORGANISATION",
      options.linkedBy ?? "mirror:create",
    );
    await grantRole(
      tx,
      organizationId,
      party.partyId,
      "ORGANISATION",
      options.linkedBy ?? "mirror:create",
    );

    return legacyOrganisationRow(tx, crmOrganizationId, organizationId, party, legacyOwnedPatch);
  });
}

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
    for (const crmOrganizationId of ids) {
      if (partyByOrg.has(crmOrganizationId)) continue;
      const adopted = await adoptOrganisation(tx, organizationId, crmOrganizationId);
      if (adopted) partyByOrg.set(crmOrganizationId, adopted);
    }

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
