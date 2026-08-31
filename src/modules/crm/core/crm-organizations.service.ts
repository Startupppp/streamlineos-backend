import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { aliasedTable, and, asc, count, desc, eq, ilike, isNull, lt, or, sql } from "drizzle-orm";
import { tickets } from "../../../db/schema";
import { businessParties, contactPartyMap, crmOrgPartyMap } from "../../../db/schema/party";
import { CONTACT_MIRROR, ORGANISATION_MIRROR } from "../../party/party-legacy-mirror";
import {
  createMirroredOrganization,
  softDeleteMirroredOrganizations,
  updateMirroredOrganization,
} from "../../party/party-legacy-orgs";
import { PARTY_OF_CRM_ORG } from "../crm-party-reads";
import { crmOrgIdsOfParties } from "../../party/party-legacy-employer";
import { leadIdsOfParties, parentColumnOf } from "../../party/party-legacy-associations";
import { isLegacyResolved, resolveLegacyParty } from "../../party/party-legacy-seam";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import type {
  OrgDuplicatesQueryInput,
  OrganizationCreateInput,
  OrganizationListInput,
  OrganizationUpdateInput,
} from "./dto/organizations.schemas";

const DUPLICATE_CANDIDATE_LIMIT = 5;
const ORG_EMPLOYEE_LIMIT = 100;

/**
 * `business_parties` a second time, as the person rather than the company.
 *
 * The employer link is self-referential, so the detail read has both ends of it
 * in one query and each needs its own name.
 */
const employee = aliasedTable(businessParties, "employee_party");

/**
 * Companies, which are parties.
 *
 * Ticket 25's half of the convergence. `crm_organizations` was the fifth
 * identity table — a company record with a name, a domain, an industry, a health
 * score and its own merge service, which is Party built twice — so this surface
 * now reads `business_parties` where `party_kind = 'ORGANISATION'` and joins
 * `crm_org_party_map` only to keep answering in the integer ids that every
 * bookmark, `roadmap_items.crm_organization_id` and `tickets.customer_id` is
 * still holding. `/crm/organizations` and `/party/parties?partyKind=ORGANISATION`
 * are now one list under two routes rather than two lists.
 *
 * The inner join to the map is what supplies that `id`, and it is the reason a
 * company created directly on the Party surface does not appear here yet. When
 * `crm_organizations` is dropped the join goes with it and the party id becomes
 * the id.
 *
 * Every write goes through `party-legacy-orgs.ts`, as tickets 03–07 did for the
 * other four tables. Nothing in this file writes `crm_organizations` directly.
 */
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

@Injectable()
export class CrmOrganizationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  /**
   * The party behind a company id, with the tenant asserted on both sides.
   *
   * A company in another organisation resolves to nothing rather than to a
   * forbidden, so the caller can 404 it: a 403 on somebody else's id confirms
   * the record exists.
   */
  private async partyOf(orgId: string, crmOrganizationId: number): Promise<string | null> {
    const resolution = await resolveLegacyParty(this.db, orgId, {
      kind: "ORGANISATION",
      legacyId: crmOrganizationId,
    });
    if (!isLegacyResolved(resolution) || resolution.party.deletedAt) return null;
    return resolution.party.partyId;
  }

  /**
   * What makes a party a company on this surface, with the tenant on both sides.
   *
   * The tenant is named as a literal on the map AND on the party rather than
   * left to the join to correlate: `PARTY_OF_CRM_ORG` already makes a
   * cross-tenant party unreachable, and restating it means a hand-written
   * `party_id` in a WHERE cannot reach one either.
   */
  private static isCompany(orgId: string) {
    return and(
      eq(crmOrgPartyMap.organizationId, orgId),
      eq(businessParties.organizationId, orgId),
      eq(businessParties.partyKind, "ORGANISATION"),
      isNull(businessParties.deletedAt),
    );
  }

  /** The company projection, spelled once for the three reads that share it. */
  private companyQuery() {
    return this.db.select(COMPANY_COLUMNS).from(crmOrgPartyMap).innerJoin(businessParties, PARTY_OF_CRM_ORG);
  }

  private countCompanies(where: ReturnType<typeof and>) {
    return this.db
      .select({ count: count() })
      .from(crmOrgPartyMap)
      .innerJoin(businessParties, PARTY_OF_CRM_ORG)
      .where(where)
      .then((rows) => rows[0]);
  }

  list(orgId: string, filters: OrganizationListInput) {
    const searchTerm = (filters.search ?? filters.q ?? "").trim();
    const key = `${filters.page}:${filters.pageSize}:${searchTerm}`;
    return this.cache.cachedVersioned(
      CACHE_KEYS.crmOrganizationsListNamespace(orgId),
      key,
      () => this.queryList(orgId, filters, searchTerm),
      CACHE_TTL.SHORT,
    );
  }

  private async queryList(orgId: string, filters: OrganizationListInput, searchTerm: string) {
    const limit = filters.pageSize;
    const offset = (filters.page - 1) * filters.pageSize;
    const where = and(
      CrmOrganizationsService.isCompany(orgId),
      searchTerm ? ilike(businessParties.name, `%${escapeLike(searchTerm)}%`) : undefined,
    );

    const openRequestsSq = this.db
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

    const [organizations, countRow] = await Promise.all([
      this.db
        .select({
          ...COMPANY_COLUMNS,
          openRequestCount: sql<number>`COALESCE(${openRequestsSq.openCount}, 0)`,
        })
        .from(crmOrgPartyMap)
        .innerJoin(businessParties, PARTY_OF_CRM_ORG)
        .leftJoin(openRequestsSq, eq(openRequestsSq.customerId, crmOrgPartyMap.crmOrganizationId))
        // `created_at` alone is not a total order -- a backfill stamped whole
        // batches with the same second -- so page two could repeat or skip a
        // company. The id breaks the tie.
        .orderBy(desc(businessParties.createdAt), desc(crmOrgPartyMap.crmOrganizationId))
        .where(where)
        .limit(limit)
        .offset(offset),
      this.countCompanies(where),
    ]);

    const totalCount = Number(countRow?.count ?? 0);
    const totalPages = totalCount === 0 ? 0 : Math.ceil(totalCount / filters.pageSize);
    return { organizations, totalCount, page: filters.page, totalPages };
  }

  /**
   * Same criteria the duplicate REPORT uses: exact domain match, or a
   * case-insensitive name match. Surfaced as a WARNING, never a block — two
   * genuinely distinct customers can share a name, and refusing the write would
   * be the irreversible choice. Callers decide what to do with it.
   */
  async findPotentialDuplicates(
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

    const rows = await this.companyQuery()
      .where(and(CrmOrganizationsService.isCompany(orgId), or(...predicates)))
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
  async getDuplicateOrgs(orgId: string, query: OrgDuplicatesQueryInput) {
    const other = aliasedTable(businessParties, "other_party");
    const otherMap = aliasedTable(crmOrgPartyMap, "other_map");

    const rows = await this.db
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
          CrmOrganizationsService.isCompany(orgId),
          eq(other.partyKind, "ORGANISATION"),
          isNull(other.deletedAt),
          // Each pair once, in one arrangement.
          lt(crmOrgPartyMap.crmOrganizationId, otherMap.crmOrganizationId),
          or(
            and(sql`${businessParties.domain} IS NOT NULL`, eq(businessParties.domain, other.domain)),
            sql`lower(${businessParties.name}) = lower(${other.name})`,
          ),
        ),
      )
      .orderBy(asc(crmOrgPartyMap.crmOrganizationId), asc(otherMap.crmOrganizationId))
      .limit(query.limit)
      .offset((query.page - 1) * query.limit);

    return rows.map((row) => ({
      org1: { id: row.id1, name: row.name1, domain: row.domain1 },
      org2: { id: row.id2, name: row.name2, domain: row.domain2 },
      matchReason: row.matchesDomain ? "domain" : "name",
    }));
  }

  async create(orgId: string, input: OrganizationCreateInput) {
    const possibleDuplicates = await this.findPotentialDuplicates(orgId, {
      name: input.name,
      domain: input.domain ?? null,
    });

    const row = await createMirroredOrganization(this.db, orgId, {
      orgId,
      name: input.name,
      domain: input.domain ?? null,
      industry: input.industry ?? null,
      size: input.size ?? null,
      website: input.website || null,
      linkedinUrl: input.linkedinUrl || null,
      description: input.description ?? null,
    });

    await this.invalidateOrgCaches(orgId);
    return {
      id: row.id,
      name: row.name,
      domain: row.domain,
      industry: row.industry,
      size: row.size,
      website: row.website,
      linkedinUrl: row.linkedinUrl,
      description: row.description,
      createdAt: row.createdAt,
      possibleDuplicates,
    };
  }

  /**
   * One company and the people who work there.
   *
   * The employees come off `employer_party_id` rather than
   * `contacts.organization_id` — the whole point of ticket 25 is that a party's
   * employer is another party, which is what makes "who else works here" a
   * question with an answer. The response keeps the `contacts` and
   * `crm_organizations` shapes it has always had, but both are now *derived*
   * rather than read: the mirrored columns come from the same
   * `party-legacy-mirror` derivation the writer uses, and the handful of
   * legacy-owned ids are resolved through the maps. So a caller reads the party's
   * values, and neither legacy table is touched.
   */
  async getWithContacts(orgId: string, id: number) {
    const partyId = await this.partyOf(orgId, id);
    if (!partyId) return null;

    const [[party], employees] = await Promise.all([
      this.db
        .select()
        .from(businessParties)
        .where(
          and(eq(businessParties.partyId, partyId), eq(businessParties.organizationId, orgId)),
        )
        .limit(1),
      this.db
        .select({ contactId: contactPartyMap.contactId, party: employee })
        .from(employee)
        .innerJoin(
          contactPartyMap,
          and(
            eq(contactPartyMap.partyId, employee.partyId),
            eq(contactPartyMap.organizationId, employee.organizationId),
          ),
        )
        .where(
          and(
            eq(employee.organizationId, orgId),
            eq(employee.employerPartyId, partyId),
            isNull(employee.deletedAt),
          ),
        )
        // Named, then keyed: the list is shown to a person, and `created_at`
        // alone repeats across a bulk import.
        .orderBy(asc(employee.name), asc(contactPartyMap.contactId))
        .limit(ORG_EMPLOYEE_LIMIT),
    ]);
    if (!party) return null;

    /*
     * The legacy-owned ids, resolved once for the page. `organization_id` is the
     * same for every employee by construction — they are the people whose employer
     * IS this party — so it is one lookup rather than one per row, and it goes
     * through the same lowest-id-wins rule the mirror writes the column with.
     */
    const [companyLegacyIds, employerLegacyId, leadIds] = await Promise.all([
      parentColumnOf(this.db, orgId, party.parentPartyId),
      crmOrgIdsOfParties(this.db, orgId, [partyId]),
      leadIdsOfParties(
        this.db,
        orgId,
        employees
          .map((row) => row.party.convertedFromPartyId)
          .filter((id): id is string => id !== null),
      ),
    ]);

    return {
      // The `crm_organizations` shape: its own id, the hierarchy pointer, the
      // stamps 0264 carried onto the party, and everything else derived.
      id,
      orgId,
      parentId: companyLegacyIds.parentId,
      /*
       * Always null, and kept rather than dropped so the response shape does not
       * change. `crm_organizations.merged_into_id` is not written any more —
       * `party_merges` is the record, and a second pointer nothing can revert is
       * worse than none — and every row that carries a historical value was
       * soft-deleted by the merge that set it, which `partyOf` above refuses.
       */
      mergedIntoId: null,
      createdAt: party.createdAt,
      updatedAt: party.updatedAt,
      ...ORGANISATION_MIRROR.derive(party),
      contacts: employees.map((row) => ({
        id: row.contactId,
        orgId,
        organizationId: employerLegacyId.get(partyId) ?? null,
        leadId: row.party.convertedFromPartyId
          ? (leadIds.get(row.party.convertedFromPartyId) ?? null)
          : null,
        // Null for the reason `contacts.service.ts` records: the only writer of
        // this column sets `deleted_at` in the same statement, and the query above
        // excludes deleted employees.
        mergedIntoId: null,
        createdAt: row.party.createdAt,
        updatedAt: row.party.updatedAt,
        ...CONTACT_MIRROR.derive(row.party),
      })),
    };
  }

  async exists(orgId: string, id: number): Promise<boolean> {
    return Boolean(await this.partyOf(orgId, id));
  }

  private async invalidateOrgCaches(orgId: string): Promise<void> {
    await Promise.all([
      this.cache.invalidateNamespace(CACHE_KEYS.crmOrganizationsListNamespace(orgId)),
      this.cache.invalidateNamespace(CACHE_KEYS.crmOrganizationDetailNamespace(orgId)),
    ]);
  }

  async applyUpdate(orgId: string, id: number, input: OrganizationUpdateInput) {
    const updated = await updateMirroredOrganization(this.db, orgId, id, {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.domain !== undefined && { domain: input.domain }),
      ...(input.industry !== undefined && { industry: input.industry }),
      ...(input.size !== undefined && { size: input.size }),
      ...(input.website !== undefined && { website: input.website }),
      ...(input.linkedinUrl !== undefined && { linkedinUrl: input.linkedinUrl }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.healthScore !== undefined && { healthScore: input.healthScore }),
      ...(input.parentId !== undefined && { parentId: input.parentId }),
      ...(input.notes !== undefined && { notes: input.notes }),
    });
    await this.invalidateOrgCaches(orgId);
    return updated;
  }

  async remove(orgId: string, id: number): Promise<boolean> {
    const [removed] = await softDeleteMirroredOrganizations(this.db, orgId, [id]);
    await this.invalidateOrgCaches(orgId);
    return Boolean(removed);
  }

}
