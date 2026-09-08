import { and, eq, inArray, isNull } from "drizzle-orm";
import { crmOrgPartyMap } from "../../db/schema/party";
import { crmOrganizations } from "../../db/schema/crm/contacts";
import { ORGANISATION_MIRROR } from "./party-legacy-mirror";
import {
  absorbParentColumn,
  parentColumnOf,
  withoutSelfLinks,
} from "./party-legacy-associations";
import { crmOrgIdsOfParties, linkedPartyId, partyIdsOfCrmOrgs } from "./party-legacy-employer";
import {
  applyPartyPatch,
  grantRoles,
  groupByPayload,
  insertBareParties,
  insertBareParty,
  movePartiesFor,
  type CrmOrgInsert,
  type CrmOrgRow,
  type MirrorDb,
  type MirrorWriteOptions,
} from "./party-legacy-writer";

/**
 * The `crm_organizations` entry points, Party-first.
 *
 * The fourth of these files. `crm_organizations` was never counted as an identity
 * table, but it carries a name, a domain, an industry, a health score, a parent
 * pointer, a merge pointer and its own merge service, which is Party built a
 * second time. Ticket 25 converged it, and its writes go here from now on.
 *
 * The one difference from its three siblings: a company gets no `party_roles`
 * row. See `ROLE_FOR_KIND` in the writer for why — the call below is still made,
 * so that the decision lives in one place rather than in an omission here.
 *
 * `parent_id` is an integer company id against a party id, so translating it
 * needs `crm_org_party_map` and therefore a query — which a `MirrorCell` cannot
 * do. Both directions run through `party-legacy-associations.ts` and nowhere
 * else, and every path below reads that map ONCE per set.
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

const unresolvedParent = (id: number): string =>
  `Organization ${id} has no party in this tenant; run the 0264 backfill before parenting to it`;

/**
 * Gives company rows that predate the backfill a Party, on first write.
 *
 * The same adoption path the other three kinds have: a row restored from a
 * backup, or imported out of band, still has to be writable, and failing the
 * write because the migration has not seen it would make the mirror the thing
 * standing between a user and their own data. A whole set at a time; see
 * `adoptLeads` for the shape.
 */
async function adoptOrganisations(
  db: MirrorDb,
  organizationId: string,
  crmOrganizationIds: readonly number[],
): Promise<Map<number, string>> {
  const adopted = new Map<number, string>();
  if (crmOrganizationIds.length === 0) return adopted;

  const rows = await db
    .select()
    .from(crmOrganizations)
    .where(
      and(
        eq(crmOrganizations.orgId, organizationId),
        inArray(crmOrganizations.id, [...crmOrganizationIds]),
      ),
    )
    .limit(crmOrganizationIds.length);
  if (rows.length === 0) return adopted;

  const parentIds = rows.map((row) => row.parentId).filter((id): id is number => id !== null);
  const partyByParent = new Map(await partyIdsOfCrmOrgs(db, organizationId, parentIds));

  const partyIds = await insertBareParties(db, organizationId, rows.map((row) => row.name));
  const legacyByParty = new Map(
    rows.map((row, index): [string, CrmOrgRow] => [partyIds[index], row]),
  );

  // The parties this call is minting, added to the map the read produced: a
  // subsidiary and its parent can both arrive unadopted in the same set, and the
  // loop this replaced resolved that only when the parent came first in the ids.
  rows.forEach((row, index) => partyByParent.set(row.id, partyIds[index]));

  await movePartiesFor(db, organizationId, partyIds, (party) => {
    const legacy = legacyByParty.get(party.partyId);
    if (!legacy) return {};
    return withoutSelfLinks(
      {
        ...ORGANISATION_MIRROR.split(legacy, party).partyPatch,
        partyKind: "ORGANISATION",
        parentPartyId: linkedPartyId(partyByParent, legacy.parentId, unresolvedParent),
      },
      party.partyId,
    );
  });

  const links = rows.map((row, index) => ({
    organizationId,
    crmOrganizationId: row.id,
    partyId: partyIds[index],
    linkedBy: "mirror:adopt",
  }));

  await db.insert(crmOrgPartyMap).values(links).onConflictDoNothing();
  await grantRoles(db, organizationId, partyIds, "ORGANISATION", "mirror:adopt");

  for (const link of links) adopted.set(link.crmOrganizationId, link.partyId);
  return adopted;
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

    const [row] = await tx
      .insert(crmOrganizations)
      .values({
        orgId: organizationId,
        name: party.name,
        ...ORGANISATION_MIRROR.derive(party),
        ...(await parentColumnOf(tx, organizationId, party.parentPartyId)),
        ...legacyOwnedPatch,
      })
      .returning();
    if (!row) throw new Error("Failed to mirror the party into crm_organizations");

    await tx.insert(crmOrgPartyMap).values({
      organizationId,
      crmOrganizationId: row.id,
      partyId: party.partyId,
      linkedBy: options.linkedBy ?? "mirror:create",
    });
    await grantRoles(
      tx,
      organizationId,
      [party.partyId],
      "ORGANISATION",
      options.linkedBy ?? "mirror:create",
    );
    return row;
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
    const unadopted = ids.filter((crmOrganizationId) => !partyByOrg.has(crmOrganizationId));
    const adopted = await adoptOrganisations(tx, organizationId, unadopted);
    for (const [crmOrganizationId, partyId] of adopted) partyByOrg.set(crmOrganizationId, partyId);

    /*
     * Resolved once, outside the per-party derivation: which parent the caller
     * named is a property of the patch, not of whichever company is being patched.
     * The self-check is not a property of the patch, so it stays inside — and it
     * is the one that matters here, because re-parenting the children of a loser
     * onto the survivor can hand a company itself.
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

    // The hierarchy resolved once for the whole set, for the reason the patch half
    // above is: reading it per derived row was a query per child.
    const parentPartyIds = [...moved.values()]
      .map((party) => party.parentPartyId)
      .filter((id): id is string => id !== null);
    const legacyByParent = await crmOrgIdsOfParties(tx, organizationId, parentPartyIds);

    const derived: { id: number; payload: Partial<CrmOrgInsert> }[] = [];
    for (const [crmOrganizationId, partyId] of partyByOrg) {
      const party = moved.get(partyId);
      if (!party) continue;
      const { legacyOwnedPatch } = ORGANISATION_MIRROR.split(patch, party);
      derived.push({
        id: crmOrganizationId,
        payload: {
          ...ORGANISATION_MIRROR.derive(party),
          parentId: party.parentPartyId
            ? (legacyByParent.get(party.parentPartyId) ?? null)
            : null,
          ...legacyOwnedPatch,
        },
      });
    }

    const updated: CrmOrgRow[] = [];
    for (const group of groupByPayload(derived)) {
      const rows = await tx
        .update(crmOrganizations)
        .set(group.payload)
        .where(
          and(
            eq(crmOrganizations.orgId, organizationId),
            inArray(crmOrganizations.id, group.ids),
          ),
        )
        .returning();
      updated.push(...rows);
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

/** Idempotent, for the reason recorded on `softDeleteMirroredLeads`. */
export async function softDeleteMirroredOrganizations(
  db: MirrorDb,
  organizationId: string,
  crmOrganizationIds: readonly number[],
): Promise<CrmOrgRow[]> {
  const ids = [...new Set(crmOrganizationIds)].filter((id) => Number.isInteger(id));
  if (ids.length === 0) return [];
  const live = await db
    .select({ id: crmOrganizations.id })
    .from(crmOrganizations)
    .where(
      and(
        eq(crmOrganizations.orgId, organizationId),
        inArray(crmOrganizations.id, ids),
        isNull(crmOrganizations.deletedAt),
      ),
    );
  return updateMirroredOrganizations(
    db,
    organizationId,
    live.map((row) => row.id),
    { deletedAt: new Date() },
  );
}
