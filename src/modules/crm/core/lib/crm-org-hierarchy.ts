import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { businessParties, crmOrgPartyMap } from "../../../../db/schema/party";
import { PARTY_OF_CRM_ORG } from "../../crm-party-reads";
import { crmOrgIdsOfParties, partyIdsOfCrmOrgs } from "../../../party/party-legacy-employer";
import { type Db } from "../../../../db/drizzle.module";

/**
 * Walking `parent_party_id`, and translating parties back into company ids.
 *
 * Two recursive CTEs and the id resolution they both need. They descend
 * `business_parties` — 0265 absorbed the account hierarchy as `parent_party_id`,
 * a second party-to-party link of the same shape as `employer_party_id` rather
 * than a second meaning for it, because a subsidiary's parent is not its
 * employer — and the map is joined only to answer in the integer ids every URL
 * still holds.
 *
 * The two walks are a guard and a read of the same edge: `wouldCreateCycle` runs
 * BEFORE a parent is set and climbs ancestors, `getAllDescendantIds` runs after
 * and descends. They share `HIERARCHY_MAX_DEPTH`, and a depth cap that differed
 * between them would mean a tree could be built that cannot be displayed. Having
 * them in one file is what makes that hard to do by accident.
 *
 * `companies` lives here rather than beside its busiest caller because resolving
 * `parent_id` is the hierarchy question: `crm_org_party_map`'s `party_id` side is
 * deliberately not unique, so it applies the same lowest-id-wins rule the mirror
 * writes `parent_id` with. The rollup and the timeline import it for the name and
 * the party id.
 */

const HIERARCHY_MAX_DEPTH = 100;

export interface OrgHierarchyNode {
  id: number;
  name: string;
  industry: string | null;
  healthScore: number | null;
  parentId: number | null;
  children: OrgHierarchyNode[];
}

export interface CrmOrgHierarchyDeps {
  readonly db: Db;
}

export async function wouldCreateCycle(
  deps: CrmOrgHierarchyDeps,
  orgId: string,
  accountId: number,
  candidateParentId: number,
): Promise<boolean> {
  if (candidateParentId === accountId) return true;

  const parties = await partyIdsOfCrmOrgs(deps.db, orgId, [accountId, candidateParentId]);
  const accountPartyId = parties.get(accountId);
  const candidatePartyId = parties.get(candidateParentId);
  // A company with no party cannot be in anybody's hierarchy, so it cannot
  // close a cycle either. The caller reads this as "go ahead", which is what
  // the legacy walk answered when the row was missing.
  if (!accountPartyId || !candidatePartyId) return false;
  if (accountPartyId === candidatePartyId) return true;

  const result = await deps.db.execute(sql`
    WITH RECURSIVE ancestors AS (
      SELECT party_id, parent_party_id, 1 AS depth
      FROM business_parties
      WHERE organization_id = ${orgId} AND party_id = ${candidatePartyId} AND deleted_at IS NULL
      UNION ALL
      SELECT p.party_id, p.parent_party_id, a.depth + 1
      FROM business_parties p
      JOIN ancestors a ON p.party_id = a.parent_party_id
      WHERE p.organization_id = ${orgId} AND p.deleted_at IS NULL AND a.depth < ${HIERARCHY_MAX_DEPTH}
    )
    SELECT 1 FROM ancestors WHERE party_id = ${accountPartyId} LIMIT 1
  `);

  return result.length > 0;
}

export async function getAllDescendantIds(
  deps: CrmOrgHierarchyDeps,
  orgId: string,
  accountId: number,
): Promise<number[]> {
  const rootPartyId = (await partyIdsOfCrmOrgs(deps.db, orgId, [accountId])).get(accountId);
  if (!rootPartyId) return [accountId];

  /*
   * The walk is over parties and the map is joined at the end, not inside the
   * recursion: a party that answers to several company ids after a merge is one
   * node of the hierarchy with several names, and recursing on the names would
   * walk the same subtree once per name.
   */
  const rows = await deps.db.execute(sql`
    WITH RECURSIVE descendants AS (
      SELECT party_id, 1 AS depth
      FROM business_parties
      WHERE organization_id = ${orgId} AND party_id = ${rootPartyId} AND deleted_at IS NULL
      UNION
      SELECT p.party_id, d.depth + 1
      FROM business_parties p
      JOIN descendants d ON p.parent_party_id = d.party_id
      WHERE p.organization_id = ${orgId} AND p.deleted_at IS NULL AND d.depth < ${HIERARCHY_MAX_DEPTH}
    )
    SELECT m.crm_organization_id AS id
    FROM descendants d
    JOIN crm_org_party_map m
      ON m.organization_id = ${orgId} AND m.party_id = d.party_id
  `);

  const ids = rows.map((row) => Number(row.id)).filter((id) => Number.isInteger(id));
  return ids.length > 0 ? ids : [accountId];
}

/**
 * The company rows for a set of legacy ids, valued from their parties.
 *
 * `parent_id` is resolved after the query rather than joined. `crm_org_party_map`
 * is keyed by `(organization_id, crm_organization_id)` and its `party_id` side
 * is deliberately not unique — after a merge one surviving party answers to
 * several company ids — so joining the map a second time to name the parent
 * would duplicate the child and put it in the tree twice. `crmOrgIdsOfParties`
 * applies the same lowest-id-wins rule the mirror writes `parent_id` with.
 */
export async function companies(
  deps: CrmOrgHierarchyDeps,
  orgId: string,
  ids: readonly number[],
) {
  const rows = await deps.db
    .select({
      id: crmOrgPartyMap.crmOrganizationId,
      partyId: crmOrgPartyMap.partyId,
      name: businessParties.name,
      industry: businessParties.industry,
      healthScore: businessParties.healthScore,
      parentPartyId: businessParties.parentPartyId,
      notes: businessParties.notes,
    })
    .from(crmOrgPartyMap)
    .innerJoin(businessParties, PARTY_OF_CRM_ORG)
    .where(
      and(
        eq(crmOrgPartyMap.organizationId, orgId),
        isNull(businessParties.deletedAt),
        inArray(crmOrgPartyMap.crmOrganizationId, [...ids]),
      ),
    );

  const parentIds = await crmOrgIdsOfParties(
    deps.db,
    orgId,
    rows.map((row) => row.parentPartyId).filter((id): id is string => id !== null),
  );

  return rows.map(({ parentPartyId, ...row }) => ({
    ...row,
    parentId: parentPartyId ? (parentIds.get(parentPartyId) ?? null) : null,
  }));
}

export async function getAccountHierarchy(
  deps: CrmOrgHierarchyDeps,
  orgId: string,
  accountId: number,
): Promise<OrgHierarchyNode | null> {
  const ids = await getAllDescendantIds(deps, orgId, accountId);
  const rows = await companies(deps, orgId, ids);

  const nodeMap = new Map<number, OrgHierarchyNode>();
  for (const row of rows)
    nodeMap.set(row.id, {
      id: row.id,
      name: row.name,
      industry: row.industry,
      healthScore: row.healthScore,
      parentId: row.parentId,
      children: [],
    });

  let root: OrgHierarchyNode | null = null;
  for (const node of nodeMap.values()) {
    if (node.id === accountId) root = node;
    else if (node.parentId !== null) nodeMap.get(node.parentId)?.children.push(node);
  }

  return root;
}
