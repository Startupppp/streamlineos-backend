import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, desc, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { crmOrganizations, contacts, deals, leads, tickets } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import type {
  OrganizationCreateInput,
  OrganizationListInput,
  OrganizationUpdateInput,
} from "./dto/organizations.schemas";

const HIERARCHY_MAX_DEPTH = 100;
const ORG_CONTACTS_LIMIT = 100;

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

function escapeLike(input: string): string {
  return input.replaceAll("%", "\\%").replaceAll("_", "\\_");
}

@Injectable()
export class CrmOrganizationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

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
      eq(crmOrganizations.orgId, orgId),
      isNull(crmOrganizations.deletedAt),
      searchTerm ? ilike(crmOrganizations.name, `%${escapeLike(searchTerm)}%`) : undefined,
    );

    const openRequestsSq = this.db
      .select({
        customerId: tickets.customerId,
        openCount: count().as("open_count"),
      })
      .from(tickets)
      .where(and(eq(tickets.orgId, orgId), isNull(tickets.deletedAt), sql`${tickets.customerId} IS NOT NULL`))
      .groupBy(tickets.customerId)
      .as("open_requests_sq");

    const [organizations, countRow] = await Promise.all([
      this.db
        .select({
          id: crmOrganizations.id,
          name: crmOrganizations.name,
          domain: crmOrganizations.domain,
          industry: crmOrganizations.industry,
          size: crmOrganizations.size,
          website: crmOrganizations.website,
          linkedinUrl: crmOrganizations.linkedinUrl,
          description: crmOrganizations.description,
          createdAt: crmOrganizations.createdAt,
          openRequestCount: sql<number>`COALESCE(${openRequestsSq.openCount}, 0)`,
        })
        .from(crmOrganizations)
        .leftJoin(openRequestsSq, eq(openRequestsSq.customerId, crmOrganizations.id))
        .where(where)
        .orderBy(desc(crmOrganizations.createdAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(crmOrganizations)
        .where(where)
        .then((rows) => rows[0]),
    ]);

    const totalCount = Number(countRow?.count ?? 0);
    const totalPages = totalCount === 0 ? 0 : Math.ceil(totalCount / filters.pageSize);
    return { organizations, totalCount, page: filters.page, totalPages };
  }

  async create(orgId: string, input: OrganizationCreateInput) {
    const [org] = await this.db
      .insert(crmOrganizations)
      .values({
        orgId,
        name: input.name,
        domain: input.domain ?? null,
        industry: input.industry ?? null,
        size: input.size ?? null,
        website: input.website || null,
        linkedinUrl: input.linkedinUrl || null,
        description: input.description ?? null,
      })
      .returning({
        id: crmOrganizations.id,
        name: crmOrganizations.name,
        domain: crmOrganizations.domain,
        industry: crmOrganizations.industry,
        size: crmOrganizations.size,
        website: crmOrganizations.website,
        linkedinUrl: crmOrganizations.linkedinUrl,
        description: crmOrganizations.description,
        createdAt: crmOrganizations.createdAt,
      });
    await this.invalidateOrgCaches(orgId);
    return org;
  }

  async getWithContacts(orgId: string, id: number) {
    const [orgRows, orgContacts] = await Promise.all([
      this.db
        .select()
        .from(crmOrganizations)
        .where(and(eq(crmOrganizations.id, id), eq(crmOrganizations.orgId, orgId), isNull(crmOrganizations.deletedAt)))
        .limit(1),
      this.db
        .select()
        .from(contacts)
        .where(
          and(
            eq(contacts.orgId, orgId),
            eq(contacts.organizationId, id),
            isNull(contacts.deletedAt),
          ),
        )
        .limit(ORG_CONTACTS_LIMIT),
    ]);

    const [org] = orgRows;
    if (!org) return null;

    return { ...org, contacts: orgContacts };
  }

  async exists(orgId: string, id: number): Promise<boolean> {
    const [row] = await this.db
      .select({ id: crmOrganizations.id })
      .from(crmOrganizations)
      .where(and(eq(crmOrganizations.id, id), eq(crmOrganizations.orgId, orgId), isNull(crmOrganizations.deletedAt)));
    return Boolean(row);
  }

  private async invalidateOrgCaches(orgId: string): Promise<void> {
    await Promise.all([
      this.cache.invalidateNamespace(CACHE_KEYS.crmOrganizationsListNamespace(orgId)),
      this.cache.invalidateNamespace(CACHE_KEYS.crmOrganizationDetailNamespace(orgId)),
    ]);
  }

  async applyUpdate(orgId: string, id: number, input: OrganizationUpdateInput) {
    const updated = await this.db
      .update(crmOrganizations)
      .set({
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
        updatedAt: new Date(),
      })
      .where(and(eq(crmOrganizations.id, id), eq(crmOrganizations.orgId, orgId)))
      .returning()
      .then((rows) => rows[0]);
    await this.invalidateOrgCaches(orgId);
    return updated;
  }

  async remove(orgId: string, id: number): Promise<boolean> {
    const [updated] = await this.db
      .update(crmOrganizations)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(crmOrganizations.id, id), eq(crmOrganizations.orgId, orgId), isNull(crmOrganizations.deletedAt)))
      .returning({ id: crmOrganizations.id });
    await this.invalidateOrgCaches(orgId);
    return Boolean(updated);
  }

  async wouldCreateCycle(orgId: string, accountId: number, candidateParentId: number): Promise<boolean> {
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

  async getAccountHierarchy(orgId: string, accountId: number): Promise<OrgHierarchyNode | null> {
    const ids = await this.getAllDescendantIds(orgId, accountId);

    const rows = await this.db
      .select({
        id: crmOrganizations.id,
        name: crmOrganizations.name,
        industry: crmOrganizations.industry,
        healthScore: crmOrganizations.healthScore,
        parentId: crmOrganizations.parentId,
      })
      .from(crmOrganizations)
      .where(and(eq(crmOrganizations.orgId, orgId), isNull(crmOrganizations.deletedAt), inArray(crmOrganizations.id, ids)));

    const nodeMap = new Map<number, OrgHierarchyNode>();
    for (const row of rows) {
      nodeMap.set(row.id, { ...row, children: [] });
    }

    let root: OrgHierarchyNode | null = null;
    for (const node of nodeMap.values()) {
      if (node.id === accountId) {
        root = node;
      } else if (node.parentId !== null && nodeMap.has(node.parentId)) {
        nodeMap.get(node.parentId)!.children.push(node);
      }
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

    const contactCountRows = await this.db
      .select({ count: sql<string>`count(*)` })
      .from(contacts)
      .where(
        and(
          eq(contacts.orgId, orgId),
          sql`${contacts.organizationId} = ANY(ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::int[])`,
        ),
      );

    const totalContacts = Number(contactCountRows[0]?.count ?? 0);

    const orgRows = await this.db
      .select({ name: crmOrganizations.name })
      .from(crmOrganizations)
      .where(and(eq(crmOrganizations.orgId, orgId), isNull(crmOrganizations.deletedAt), inArray(crmOrganizations.id, ids)));

    const orgNames = orgRows.map((r) => r.name);

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
            or(...orgNames.map((n) => ilike(deals.name, `%${n.replaceAll("%", "\\%")}%`))),
          ),
        );

      totalDeals = Number(dealAgg[0]?.totalDeals ?? 0);
      openDeals = Number(dealAgg[0]?.openDeals ?? 0);
      totalDealValue = Number(dealAgg[0]?.totalDealValue ?? 0);
    }

    const leadCountRows = await this.db
      .select({ count: sql<string>`count(*)` })
      .from(leads)
      .where(
        and(
          eq(leads.orgId, orgId),
          isNull(leads.deletedAt),
          orgNames.length > 0
            ? or(...orgNames.map((n) => ilike(leads.company, `%${n.replaceAll("%", "\\%")}%`)))
            : sql`false`,
        ),
      );

    const totalLeads = Number(leadCountRows[0]?.count ?? 0);

    return { totalContacts, totalDeals, openDeals, totalDealValue, totalLeads };
  }

  getAccountTimeline(orgId: string, accountId: number, limit = 20): Promise<OrgTimelineEvent[]> {
    return this.cache.cachedVersioned(
      CACHE_KEYS.crmOrganizationDetailNamespace(orgId),
      `timeline:${accountId}:${limit}`,
      () => this.queryAccountTimeline(orgId, accountId, limit),
      CACHE_TTL.SHORT,
    );
  }

  private async queryAccountTimeline(orgId: string, accountId: number, limit: number): Promise<OrgTimelineEvent[]> {
    const orgRow = await this.db
      .select({ name: crmOrganizations.name, notes: crmOrganizations.notes })
      .from(crmOrganizations)
      .where(and(eq(crmOrganizations.id, accountId), eq(crmOrganizations.orgId, orgId), isNull(crmOrganizations.deletedAt)))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (!orgRow) return [];

    const safeName = orgRow.name.replaceAll("%", "\\%");

    const [contactRows, dealRows, leadRows] = await Promise.all([
      this.db
        .select({ id: contacts.id, name: contacts.name, createdAt: contacts.createdAt })
        .from(contacts)
        .where(and(eq(contacts.orgId, orgId), eq(contacts.organizationId, accountId)))
        .orderBy(sql`${contacts.createdAt} desc`)
        .limit(limit),
      this.db
        .select({ id: deals.id, name: deals.name, stage: deals.stage, createdAt: deals.createdAt })
        .from(deals)
        .where(and(eq(deals.orgId, orgId), ilike(deals.name, `%${safeName}%`)))
        .orderBy(sql`${deals.createdAt} desc`)
        .limit(limit),
      this.db
        .select({ id: leads.id, name: leads.name, createdAt: leads.createdAt })
        .from(leads)
        .where(and(eq(leads.orgId, orgId), isNull(leads.deletedAt), ilike(leads.company, `%${safeName}%`)))
        .orderBy(sql`${leads.createdAt} desc`)
        .limit(limit),
    ]);

    const events: OrgTimelineEvent[] = [];

    for (const c of contactRows) {
      events.push({
        id: `contact-${c.id}`,
        date: c.createdAt?.toISOString() ?? new Date().toISOString(),
        type: "contact_created",
        description: `Contact "${c.name}" added to organization`,
        entityId: c.id,
      });
    }

    for (const d of dealRows) {
      events.push({
        id: `deal-${d.id}`,
        date: d.createdAt?.toISOString() ?? new Date().toISOString(),
        type: "deal_created",
        description: `Deal "${d.name}" (${d.stage}) linked`,
        entityId: d.id,
      });
    }

    for (const l of leadRows) {
      events.push({
        id: `lead-${l.id}`,
        date: l.createdAt?.toISOString() ?? new Date().toISOString(),
        type: "lead_linked",
        description: `Lead "${l.name ?? "Unnamed"}" linked (company match)`,
        entityId: l.id,
      });
    }

    if (orgRow.notes) {
      events.push({
        id: `note-${accountId}`,
        date: new Date().toISOString(),
        type: "note_added",
        description: "Account notes updated",
        entityId: accountId,
      });
    }

    return events
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, limit);
  }

  async getRelatedLeads(orgId: string, id: number) {
    const [org] = await this.db
      .select({ name: crmOrganizations.name })
      .from(crmOrganizations)
      .where(and(eq(crmOrganizations.id, id), eq(crmOrganizations.orgId, orgId), isNull(crmOrganizations.deletedAt)));

    if (!org) return null;

    const linkedContactLeadIds = await this.db
      .select({ leadId: contacts.leadId })
      .from(contacts)
      .where(and(eq(contacts.orgId, orgId), eq(contacts.organizationId, id)))
      .then((rows) => rows.map((r) => r.leadId).filter((lid): lid is number => lid !== null));

    const safeName = org.name.replaceAll("%", "\\%").replaceAll("_", "\\_");

    const conditions = [ilike(leads.company, `%${safeName}%`)];
    if (linkedContactLeadIds.length > 0) {
      conditions.push(inArray(leads.id, linkedContactLeadIds));
    }

    return this.db
      .select({
        id: leads.id,
        name: leads.name,
        email: leads.email,
        phone: leads.phone,
        status: leads.status,
        priority: leads.priority,
        company: leads.company,
        source: leads.source,
        createdAt: leads.createdAt,
      })
      .from(leads)
      .where(and(eq(leads.orgId, orgId), isNull(leads.deletedAt), or(...conditions)))
      .orderBy(leads.createdAt)
      .limit(50);
  }
}
