import { and, eq, inArray, isNull } from "drizzle-orm";
import { crmOrgPartyMap } from "../../db/schema/party";
import { crmOrganizations } from "../../db/schema/crm/contacts";
import { ORGANISATION_MIRROR } from "./party-legacy-mirror";
import {
  absorbParentColumn,
  parentColumnOf,
  withoutSelfLinks,
} from "./party-legacy-associations";
import {
  applyPartyPatch,
  grantRole,
  groupByPayload,
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
 * The fourth of these files and the last one the phase discovered it needed.
 * `crm_organizations` was never counted as an identity table — the split was
 * meant to be `contacts`, `clients`, `leads` and Party — but it carries a name, a
 * domain, an industry, a health score, a parent pointer, a merge pointer and its
 * own merge service, which is Party built a second time. Ticket 25 converged it,
 * and this is where its writes go from here.
 *
 * The one difference from its three siblings: a company gets no `party_roles`
 * row. See `ROLE_FOR_KIND` in the writer for why — the call below is still made,
 * so that the decision lives in one place rather than in an omission here.
 *
 * One column does not go through the field map. `crm_organizations.parent_id` is
 * an integer company id and its Party counterpart `parent_party_id` is a party
 * id, so translating needs `crm_org_party_map` and therefore a query — which a
 * `MirrorCell` deliberately cannot do. Both directions run through
 * `party-legacy-associations.ts` at the three points below, and nowhere else.
 * Ticket 25 left the hierarchy on the legacy row and said converging it was the
 * follow-up; 0265 is that follow-up, and this is where its writes go.
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
    await grantRole(
      tx,
      organizationId,
      party.partyId,
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

    const derived: { id: number; payload: Partial<CrmOrgInsert> }[] = [];
    for (const [crmOrganizationId, partyId] of partyByOrg) {
      const party = moved.get(partyId);
      if (!party) continue;
      const { legacyOwnedPatch } = ORGANISATION_MIRROR.split(patch, party);
      derived.push({
        id: crmOrganizationId,
        payload: {
          ...ORGANISATION_MIRROR.derive(party),
          ...(await parentColumnOf(tx, organizationId, party.parentPartyId)),
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
