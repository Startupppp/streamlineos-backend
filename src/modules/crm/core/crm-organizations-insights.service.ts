import { Inject, Injectable } from "@nestjs/common";
import { aliasedTable, and, asc, count, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { contacts, crmOrganizations, deals } from "../../../db/schema";
import {
  businessParties,
  contactPartyMap,
  crmOrgPartyMap,
  leadPartyMap,
} from "../../../db/schema/party";
import { PARTY_OF_CRM_ORG, PARTY_OF_LEAD, leadPriority, leadSource, leadStatus } from "../crm-party-reads";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";

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
 * onto Party. These are read-only aggregates over a company, and they are the
 * half that still has to speak `crm_organizations`: the account hierarchy lives
 * in `parent_id`, which Party deliberately did not absorb — a subsidiary's
 * parent is not its employer, and one column serving both would make
 * `employer_party_id` a lie. Everything else here reads the party.
 *
 * "Who works here" is now `employer_party_id` rather than
 * `contacts.organization_id`, which is the relation ticket 25 exists to create.
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

    const result = await this.db.execute(sql`
      WITH RECURSIVE ancestors AS (
        SELECT id, parent_id, 1 AS depth
        FROM crm_organizations
        WHERE org_id = ${orgId} AND id = ${candidateParentId} AND deleted_at IS NULL
        UNION ALL
        SELECT o.id, o.parent_id, a.depth + 1
        FROM crm_organizations o
        JOIN ancestors a ON o.id = a.parent_id
        WHERE o.org_id = ${orgId} AND o.deleted_at IS NULL AND a.depth < ${HIERARCHY_MAX_DEPTH}
      )
      SELECT 1 FROM ancestors WHERE id = ${accountId} LIMIT 1
    `);

    return result.length > 0;
  }

  private async getAllDescendantIds(orgId: string, accountId: number): Promise<number[]> {
    const rows = await this.db.execute(sql`
      WITH RECURSIVE descendants AS (
        SELECT id, 1 AS depth
        FROM crm_organizations
        WHERE org_id = ${orgId} AND id = ${accountId} AND deleted_at IS NULL
        UNION
        SELECT o.id, d.depth + 1
        FROM crm_organizations o
        JOIN descendants d ON o.parent_id = d.id
        WHERE o.org_id = ${orgId} AND o.deleted_at IS NULL AND d.depth < ${HIERARCHY_MAX_DEPTH}
      )
      SELECT id FROM descendants
    `);

    const ids = rows.map((row) => Number(row.id)).filter((id) => Number.isInteger(id));
    return ids.length > 0 ? ids : [accountId];
  }

  /** The company rows for a set of legacy ids, valued from their parties. */
  private companies(orgId: string, ids: readonly number[]) {
    return this.db
      .select({
        id: crmOrgPartyMap.crmOrganizationId,
        partyId: crmOrgPartyMap.partyId,
        name: businessParties.name,
        industry: businessParties.industry,
        healthScore: businessParties.healthScore,
        parentId: crmOrganizations.parentId,
        notes: businessParties.notes,
      })
      .from(crmOrgPartyMap)
      .innerJoin(
        businessParties,
        PARTY_OF_CRM_ORG,
      )
      .innerJoin(
        crmOrganizations,
        and(
          eq(crmOrganizations.id, crmOrgPartyMap.crmOrganizationId),
          eq(crmOrganizations.orgId, crmOrgPartyMap.organizationId),
        ),
      )
      .where(
        and(
          eq(crmOrgPartyMap.organizationId, orgId),
          isNull(businessParties.deletedAt),
          inArray(crmOrgPartyMap.crmOrganizationId, [...ids]),
        ),
      );
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
    return this.cache.cachedVersioned(
      CACHE_KEYS.crmOrganizationDetailNamespace(orgId),
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
    return this.cache.cachedVersioned(
      CACHE_KEYS.crmOrganizationDetailNamespace(orgId),
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

    // The leads whose free-text employer looks like this company, plus the ones
    // an employee of it came from. `contacts.lead_id` is a legacy-to-legacy link
    // Party has no column for, so that second half stays as it was.
    const employeeLeadIds = await this.db
      .select({ leadId: contacts.leadId })
      .from(employee)
      .innerJoin(
        contactPartyMap,
        and(
          eq(contactPartyMap.partyId, employee.partyId),
          eq(contactPartyMap.organizationId, employee.organizationId),
        ),
      )
      .innerJoin(
        contacts,
        and(
          eq(contacts.id, contactPartyMap.contactId),
          eq(contacts.orgId, contactPartyMap.organizationId),
        ),
      )
      .where(
        and(
          eq(employee.organizationId, orgId),
          eq(employee.employerPartyId, company.partyId),
        ),
      )
      .then((rows) => rows.map((row) => row.leadId).filter((id): id is number => id !== null));

    const conditions = [ilike(businessParties.companyName, `%${safeName}%`)];
    if (employeeLeadIds.length > 0) conditions.push(inArray(leadPartyMap.leadId, employeeLeadIds));

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
