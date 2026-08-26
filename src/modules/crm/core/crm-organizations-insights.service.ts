import { Inject, Injectable } from "@nestjs/common";
import { aliasedTable, and, asc, count, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { deals } from "../../../db/schema";
import {
  businessParties,
  contactPartyMap,
  crmOrgPartyMap,
  leadPartyMap,
} from "../../../db/schema/party";
import { PARTY_OF_CRM_ORG, PARTY_OF_LEAD, leadPriority, leadSource, leadStatus } from "../crm-party-reads";
import { crmOrgIdsOfParties, partyIdsOfCrmOrgs } from "../../party/party-legacy-employer";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";

const HIERARCHY_MAX_DEPTH = 100;

/** The person end of the self-referential employer link; see the company end. */
const employee = aliasedTable(businessParties, "employee_party");

export interface OrgHierarchyNode {
  id: number;
  name: string;
  industry: string | null;
  healthScore: number | null;
  parentId: number | null;
  children: OrgHierarchyNode[];
}

export interface OrgRollup {
  totalContacts: number;
  totalDeals: number;
  openDeals: number;
  totalDealValue: number;
  totalLeads: number;
}

export interface OrgTimelineEvent {
  id: string;
  date: string;
  type: "contact_created" | "deal_created" | "lead_linked" | "note_added";
  description: string;
  entityId: number;
}

/**
 * What an account looks like from above: its group, its totals, its history.
 *
 * Split from `CrmOrganizationsService` when ticket 25 moved the record itself
 * onto Party. These are read-only aggregates over a company, and the half that
 * used to still speak `crm_organizations`: the account hierarchy lived in
 * `parent_id`, which ticket 25 deliberately did not absorb.
 *
 * 0265 absorbed it, as `parent_party_id` — a second link of the same shape as
 * `employer_party_id` rather than a second meaning for it, because a subsidiary's
 * parent is not its employer. So the two recursive walks below descend
 * `business_parties` and the map is joined only to answer in the integer ids
 * every URL still holds. Nothing here reads a legacy table.
 *
 * "Who works here" is `employer_party_id` rather than `contacts.organization_id`,
 * which is the relation ticket 25 exists to create.
 */
@Injectable()
export class CrmOrganizationsInsightsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async wouldCreateCycle(
    orgId: string,
    accountId: number,
    candidateParentId: number,
  ): Promise<boolean> {
    if (candidateParentId === accountId) return true;

    const parties = await partyIdsOfCrmOrgs(this.db, orgId, [accountId, candidateParentId]);
    const accountPartyId = parties.get(accountId);
    const candidatePartyId = parties.get(candidateParentId);
    // A company with no party cannot be in anybody's hierarchy, so it cannot
    // close a cycle either. The caller reads this as "go ahead", which is what
    // the legacy walk answered when the row was missing.
    if (!accountPartyId || !candidatePartyId) return false;
    if (accountPartyId === candidatePartyId) return true;

    const result = await this.db.execute(sql`
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

  private async getAllDescendantIds(orgId: string, accountId: number): Promise<number[]> {
    const rootPartyId = (await partyIdsOfCrmOrgs(this.db, orgId, [accountId])).get(accountId);
    if (!rootPartyId) return [accountId];

    /*
     * The walk is over parties and the map is joined at the end, not inside the
     * recursion: a party that answers to several company ids after a merge is one
     * node of the hierarchy with several names, and recursing on the names would
     * walk the same subtree once per name.
     */
    const rows = await this.db.execute(sql`
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
  private async companies(orgId: string, ids: readonly number[]) {
    const rows = await this.db
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
      this.db,
      orgId,
      rows.map((row) => row.parentPartyId).filter((id): id is string => id !== null),
    );

    return rows.map(({ parentPartyId, ...row }) => ({
      ...row,
      parentId: parentPartyId ? (parentIds.get(parentPartyId) ?? null) : null,
    }));
  }

  async getAccountHierarchy(orgId: string, accountId: number): Promise<OrgHierarchyNode | null> {
    const ids = await this.getAllDescendantIds(orgId, accountId);
    const rows = await this.companies(orgId, ids);

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

  getAccountRollup(orgId: string, accountId: number): Promise<OrgRollup> {
    return this.cache.cachedVersionedForOrg(
      orgId,
      "crm:organizations:detail",
      `rollup:${accountId}`,
      () => this.queryAccountRollup(orgId, accountId),
      CACHE_TTL.SHORT,
    );
  }

  private async queryAccountRollup(orgId: string, accountId: number): Promise<OrgRollup> {
    const ids = await this.getAllDescendantIds(orgId, accountId);
    const companies = await this.companies(orgId, ids);
    const partyIds = companies.map((row) => row.partyId);
    const orgNames = companies.map((row) => row.name);

    // Everyone whose employer is one of these companies. `employer_party_id`
    // rather than `contacts.organization_id`: the count is over people, and a
    // person is a party whether or not `contacts` still holds a row for them.
    const [contactCount] = partyIds.length
      ? await this.db
          .select({ count: count() })
          .from(businessParties)
          .where(
            and(
              eq(businessParties.organizationId, orgId),
              inArray(businessParties.employerPartyId, partyIds),
              isNull(businessParties.deletedAt),
            ),
          )
      : [];

    let totalDeals = 0;
    let openDeals = 0;
    let totalDealValue = 0;

    if (orgNames.length > 0) {
      const dealAgg = await this.db
        .select({
          totalDeals: count(),
          openDeals: sql<number>`COUNT(*) FILTER (WHERE ${deals.stage} NOT IN ('CLOSED_WON', 'CLOSED_LOST'))::int`,
          totalDealValue: sql<number>`COALESCE(SUM(${deals.value}::numeric), 0)::float`,
        })
        .from(deals)
        .where(
          and(
            eq(deals.orgId, orgId),
            isNull(deals.deletedAt),
            or(...orgNames.map((n) => ilike(deals.name, `%${n.replaceAll("%", "\\%")}%`))),
          ),
        );

      totalDeals = Number(dealAgg[0]?.totalDeals ?? 0);
      openDeals = Number(dealAgg[0]?.openDeals ?? 0);
      totalDealValue = Number(dealAgg[0]?.totalDealValue ?? 0);
    }

    const [leadCount] = await this.db
      .select({ count: count() })
      .from(leadPartyMap)
      .innerJoin(businessParties, PARTY_OF_LEAD)
      .where(
        and(
          eq(leadPartyMap.organizationId, orgId),
          isNull(businessParties.deletedAt),
          orgNames.length > 0
            ? or(
                ...orgNames.map((n) =>
                  ilike(businessParties.companyName, `%${n.replaceAll("%", "\\%")}%`),
                ),
              )
            : sql`false`,
        ),
      );

    return {
      totalContacts: Number(contactCount?.count ?? 0),
      totalDeals,
      openDeals,
      totalDealValue,
      totalLeads: Number(leadCount?.count ?? 0),
    };
  }

  getAccountTimeline(orgId: string, accountId: number, limit = 20): Promise<OrgTimelineEvent[]> {
    return this.cache.cachedVersionedForOrg(
      orgId,
      "crm:organizations:detail",
      `timeline:${accountId}:${limit}`,
      () => this.queryAccountTimeline(orgId, accountId, limit),
      CACHE_TTL.SHORT,
    );
  }

  private async queryAccountTimeline(
    orgId: string,
    accountId: number,
    limit: number,
  ): Promise<OrgTimelineEvent[]> {
    const [company] = await this.companies(orgId, [accountId]);
    if (!company) return [];

    const safeName = company.name.replaceAll("%", "\\%");

    const [employees, dealRows, leadRows] = await Promise.all([
      // Everyone whose employer is this company, through `employer_party_id`
      // rather than `contacts.organization_id`. The contact id still comes back
      // off the map, because the event carries one and every link the client
      // draws is still a `contacts` URL.
      this.db
        .select({
          id: contactPartyMap.contactId,
          name: employee.name,
          createdAt: employee.createdAt,
        })
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
            eq(employee.employerPartyId, company.partyId),
          ),
        )
        .orderBy(desc(employee.createdAt), desc(contactPartyMap.contactId))
        .limit(limit),
      this.db
        .select({ id: deals.id, name: deals.name, stage: deals.stage, createdAt: deals.createdAt })
        .from(deals)
        .where(
          and(
            eq(deals.orgId, orgId),
            isNull(deals.deletedAt),
            ilike(deals.name, `%${safeName}%`),
          ),
        )
        .orderBy(desc(deals.createdAt), desc(deals.id))
        .limit(limit),
      this.db
        .select({
          id: leadPartyMap.leadId,
          name: businessParties.name,
          createdAt: businessParties.createdAt,
        })
        .from(leadPartyMap)
        .innerJoin(businessParties, PARTY_OF_LEAD)
        .where(
          and(
            eq(leadPartyMap.organizationId, orgId),
            isNull(businessParties.deletedAt),
            ilike(businessParties.companyName, `%${safeName}%`),
          ),
        )
        .orderBy(desc(businessParties.createdAt), desc(leadPartyMap.leadId))
        .limit(limit),
    ]);

    const events: OrgTimelineEvent[] = [];

    for (const person of employees)
      events.push({
        id: `contact-${person.id}`,
        date: person.createdAt.toISOString(),
        type: "contact_created",
        description: `Contact "${person.name}" added to organization`,
        entityId: person.id,
      });

    for (const d of dealRows)
      events.push({
        id: `deal-${d.id}`,
        date: d.createdAt?.toISOString() ?? new Date().toISOString(),
        type: "deal_created",
        description: `Deal "${d.name}" (${d.stage}) linked`,
        entityId: d.id,
      });

    for (const l of leadRows)
      events.push({
        id: `lead-${l.id}`,
        date: l.createdAt?.toISOString() ?? new Date().toISOString(),
        type: "lead_linked",
        description: `Lead "${l.name ?? "Unnamed"}" linked (company match)`,
        entityId: l.id,
      });

    if (company.notes)
      events.push({
        id: `note-${accountId}`,
        date: new Date().toISOString(),
        type: "note_added",
        description: "Account notes updated",
        entityId: accountId,
      });

    return events
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, limit);
  }

  async getRelatedLeads(orgId: string, id: number) {
    const [company] = await this.companies(orgId, [id]);
    if (!company) return null;

    const safeName = company.name.replaceAll("%", "\\%").replaceAll("_", "\\_");

    /*
     * The leads whose free-text employer looks like this company, plus the ones an
     * employee of it came from. That second half is `converted_from_party_id`
     * since 0265, so it compares party to party -- the map is still joined to
     * confirm the employee is a contact, and to keep the set the same one the
     * legacy `contacts.lead_id` read produced.
     */
    const employeeLeadPartyIds = await this.db
      .select({ leadPartyId: employee.convertedFromPartyId })
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
          eq(employee.employerPartyId, company.partyId),
        ),
      )
      .then((rows) =>
        rows.map((row) => row.leadPartyId).filter((id): id is string => id !== null),
      );

    const conditions = [ilike(businessParties.companyName, `%${safeName}%`)];
    if (employeeLeadPartyIds.length > 0)
      conditions.push(inArray(businessParties.partyId, employeeLeadPartyIds));

    return this.db
      .select({
        id: leadPartyMap.leadId,
        name: businessParties.name,
        email: businessParties.email,
        phone: businessParties.phone,
        status: leadStatus,
        priority: leadPriority,
        company: businessParties.companyName,
        source: leadSource,
        createdAt: businessParties.createdAt,
      })
      .from(leadPartyMap)
      .innerJoin(businessParties, PARTY_OF_LEAD)
      .where(
        and(
          eq(leadPartyMap.organizationId, orgId),
          isNull(businessParties.deletedAt),
          or(...conditions),
        ),
      )
      .orderBy(asc(businessParties.createdAt), asc(leadPartyMap.leadId))
      .limit(50);
  }
}
