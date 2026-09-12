import { aliasedTable, and, asc, count, desc, eq, gt, ilike, isNull, lt, or, sql } from "drizzle-orm";
import { tickets } from "../../../../db/schema";
import { businessParties, crmOrgPartyMap } from "../../../../db/schema/party";
import { PARTY_OF_CRM_ORG } from "../../crm-party-reads";
import { type Db } from "../../../../db/drizzle.module";
import { buildCursorPage, decodeCursor } from "../../../../common/pagination/cursor";
import { keysetBefore } from "../../../../common/pagination/keyset";
import type { OrgDuplicatesQueryInput, OrganizationListInput } from "../dto/organizations.schemas";

/**
 * Reading companies as a SET, and the one rule that says two of them are one.
 *
 * `CrmOrganizationsService` applied the duplicate criteria in two places thirty
 * lines apart — once to a single candidate at create time, once as the pairwise
 * report the merge screen reads — and a doc comment on the first asserted they
 * were the same criteria. Nothing enforced that; the comment was the enforcement.
 * Both now sit in one file with `isCompany`, which is the actual thing that could
 * drift, and a change to what "the same company" means has one place to be made.
 *
 * The listing came with them because it is the third read over that same
 * projection: `COMPANY_COLUMNS` over `crm_org_party_map ⋈ business_parties`
 * filtered by `isCompany`. Nothing in here writes, and nothing in here resolves
 * a single company by id — that is `partyOf` and the legacy writers, which stay
 * on the service.
 *
 * `escapeLike` matters more than it looks: `findPotentialDuplicates` used to
 * match names with `ILIKE`, so a company called "100%_Cotton" was a LIKE
 * *pattern* and matched things it is not. The name comparison is `lower() =
 * lower()` now, and the only remaining pattern match — the list's search box —
 * escapes its input here.
 */

const DUPLICATE_CANDIDATE_LIMIT = 5;

export interface CrmOrgListingDeps {
  readonly db: Db;
}

function escapeLike(input: string): string {
  return input.replaceAll("%", "\\%").replaceAll("_", "\\_");
}

/** The company columns as the list and detail responses have always spelled them. */
const COMPANY_COLUMNS = {
  id: crmOrgPartyMap.crmOrganizationId,
  name: businessParties.name,
  domain: businessParties.domain,
  industry: businessParties.industry,
  size: businessParties.companySize,
  website: businessParties.website,
  linkedinUrl: businessParties.linkedinUrl,
  description: businessParties.description,
  createdAt: businessParties.createdAt,
};

/**
 * What makes a party a company on this surface, with the tenant on both sides.
 *
 * The tenant is named as a literal on the map AND on the party rather than
 * left to the join to correlate: `PARTY_OF_CRM_ORG` already makes a
 * cross-tenant party unreachable, and restating it means a hand-written
 * `party_id` in a WHERE cannot reach one either.
 */
function isCompany(orgId: string) {
  return and(
    eq(crmOrgPartyMap.organizationId, orgId),
    eq(businessParties.organizationId, orgId),
    eq(businessParties.partyKind, "ORGANISATION"),
    isNull(businessParties.deletedAt),
  );
}

/** The company projection, spelled once for the three reads that share it. */
function companyQuery(deps: CrmOrgListingDeps) {
  return deps.db.select(COMPANY_COLUMNS).from(crmOrgPartyMap).innerJoin(businessParties, PARTY_OF_CRM_ORG);
}

function countCompanies(deps: CrmOrgListingDeps, where: ReturnType<typeof and>) {
  return deps.db
    .select({ count: count() })
    .from(crmOrgPartyMap)
    .innerJoin(businessParties, PARTY_OF_CRM_ORG)
    .where(where)
    .then((rows) => rows[0]);
}

export async function queryOrganizationList(
  deps: CrmOrgListingDeps,
  orgId: string,
  filters: OrganizationListInput,
  searchTerm: string,
) {
  const limit = filters.pageSize;
  const position = decodeCursor(filters.cursor);
  const baseConditions = [
    isCompany(orgId),
    searchTerm ? ilike(businessParties.name, `%${escapeLike(searchTerm)}%`) : undefined,
  ].filter((condition): condition is NonNullable<typeof condition> => condition !== undefined);
  const where = position
    ? and(...baseConditions, keysetBefore(businessParties.createdAt, crmOrgPartyMap.crmOrganizationId, position))
    : and(...baseConditions);
  const countWhere = and(...baseConditions);

  const openRequestsSq = deps.db
    .select({
      customerId: tickets.customerId,
      openCount: count().as("open_count"),
    })
    .from(tickets)
    .where(
      and(
        eq(tickets.orgId, orgId),
        isNull(tickets.deletedAt),
        sql`${tickets.customerId} IS NOT NULL`,
      ),
    )
    .groupBy(tickets.customerId)
    .as("open_requests_sq");

  const [rows, countRow] = await Promise.all([
    deps.db
      .select({
        ...COMPANY_COLUMNS,
        openRequestCount: sql<number>`COALESCE(${openRequestsSq.openCount}, 0)`,
      })
      .from(crmOrgPartyMap)
      .innerJoin(businessParties, PARTY_OF_CRM_ORG)
      .leftJoin(openRequestsSq, eq(openRequestsSq.customerId, crmOrgPartyMap.crmOrganizationId))
      .orderBy(desc(businessParties.createdAt), desc(crmOrgPartyMap.crmOrganizationId))
      .where(where)
      .limit(limit + 1),
    filters.cursor === undefined ? countCompanies(deps, countWhere) : Promise.resolve(null),
  ]);

  const page = buildCursorPage(rows, limit, (r) => ({
    sortValue: r.createdAt.toISOString(),
    id: String(r.id),
  }));
  const totalCount = countRow ? Number(countRow.count ?? 0) : undefined;
  return {
    organizations: page.data,
    hasMore: page.pagination.hasMore,
    nextCursor: page.pagination.nextCursor,
    totalCount,
  };
}

/**
 * Same criteria the duplicate REPORT below uses: exact domain match, or a
 * case-insensitive name match. Surfaced as a WARNING, never a block — two
 * genuinely distinct customers can share a name, and refusing the write would
 * be the irreversible choice. Callers decide what to do with it.
 */
export async function findPotentialDuplicates(
  deps: CrmOrgListingDeps,
  orgId: string,
  input: { name?: string; domain?: string | null },
): Promise<{ id: number; name: string; domain: string | null; matchReason: "domain" | "name" }[]> {
  const predicates = [];
  if (input.domain) predicates.push(eq(businessParties.domain, input.domain));
  // `lower(x) = lower(y)`, where this used to be `ILIKE`. A company called
  // "100%_Cotton" was a LIKE *pattern* under the old spelling and matched
  // things it is not.
  if (input.name)
    predicates.push(sql`lower(${businessParties.name}) = lower(${input.name})`);
  if (predicates.length === 0) return [];

  const rows = await companyQuery(deps)
    .where(and(isCompany(orgId), or(...predicates)))
    .orderBy(asc(crmOrgPartyMap.crmOrganizationId))
    .limit(DUPLICATE_CANDIDATE_LIMIT);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    domain: row.domain,
    matchReason:
      input.domain && row.domain === input.domain ? ("domain" as const) : ("name" as const),
  }));
}

/**
 * Pairs that look like the same company.
 *
 * The report the merge screen reads, and the same criteria
 * `findPotentialDuplicates` applies to one candidate. Over parties now, which
 * is what lets a merge from this screen go through `PartyMergeService`.
 */
export async function getDuplicateOrgs(
  deps: CrmOrgListingDeps,
  orgId: string,
  query: OrgDuplicatesQueryInput,
) {
  const other = aliasedTable(businessParties, "other_party");
  const otherMap = aliasedTable(crmOrgPartyMap, "other_map");

  const limit = query.limit;
  const [cursorId1, cursorId2] = query.cursor ? query.cursor.split("_").map(Number) : [undefined, undefined];
  const hasCursor = cursorId1 !== undefined && cursorId2 !== undefined && !Number.isNaN(cursorId1) && !Number.isNaN(cursorId2);

  const rows = await deps.db
    .select({
      id1: crmOrgPartyMap.crmOrganizationId,
      name1: businessParties.name,
      domain1: businessParties.domain,
      id2: otherMap.crmOrganizationId,
      name2: other.name,
      domain2: other.domain,
      matchesDomain: sql<boolean>`${businessParties.domain} IS NOT NULL AND ${businessParties.domain} = ${other.domain}`,
    })
    .from(crmOrgPartyMap)
    .innerJoin(businessParties, PARTY_OF_CRM_ORG)
    .innerJoin(otherMap, eq(otherMap.organizationId, crmOrgPartyMap.organizationId))
    .innerJoin(
      other,
      and(eq(other.partyId, otherMap.partyId), eq(other.organizationId, otherMap.organizationId)),
    )
    .where(
      and(
        isCompany(orgId),
        eq(other.partyKind, "ORGANISATION"),
        isNull(other.deletedAt),
        lt(crmOrgPartyMap.crmOrganizationId, otherMap.crmOrganizationId),
        or(
          and(sql`${businessParties.domain} IS NOT NULL`, eq(businessParties.domain, other.domain)),
          sql`lower(${businessParties.name}) = lower(${other.name})`,
        ),
        hasCursor
          ? or(
              gt(crmOrgPartyMap.crmOrganizationId, cursorId1),
              and(
                eq(crmOrgPartyMap.crmOrganizationId, cursorId1),
                gt(otherMap.crmOrganizationId, cursorId2),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(asc(crmOrgPartyMap.crmOrganizationId), asc(otherMap.crmOrganizationId))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  const nextCursor = hasMore && last ? `${last.id1}_${last.id2}` : null;

  return {
    items: data.map((row) => ({
      org1: { id: row.id1, name: row.name1, domain: row.domain1 },
      org2: { id: row.id2, name: row.name2, domain: row.domain2 },
      matchReason: row.matchesDomain ? "domain" : "name",
    })),
    hasMore,
    nextCursor,
  };
}
