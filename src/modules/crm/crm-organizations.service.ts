import { Inject, Injectable } from "@nestjs/common";
import { and, eq, desc, ilike, inArray, not, or, sql } from "drizzle-orm";
import { crmOrganizations, contacts, deals, leads } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import type {
  OrganizationCreateInput,
  OrganizationListInput,
  OrganizationUpdateInput,
} from "./dto/organizations.schemas";

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
    const key = `crm:organizations:list:${orgId}:${filters.page}:${filters.pageSize}:${searchTerm}`;
    return this.cache.cached(
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
      searchTerm ? ilike(crmOrganizations.name, `%${escapeLike(searchTerm)}%`) : undefined,
    );

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
        })
        .from(crmOrganizations)
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
    await this.cache.invalidatePattern(`crm:organizations:list:${orgId}:*`);
    return org;
  }

  async getWithContacts(orgId: string, id: number) {
    const [org] = await this.db
      .select()
      .from(crmOrganizations)
      .where(and(eq(crmOrganizations.id, id), eq(crmOrganizations.orgId, orgId)));

    if (!org) return null;

    const orgContacts = await this.db
      .select()
      .from(contacts)
      .where(and(eq(contacts.orgId, orgId), eq(contacts.organizationId, id)));

    return { ...org, contacts: orgContacts };
  }

  async exists(orgId: string, id: number): Promise<boolean> {
    const [row] = await this.db
      .select({ id: crmOrganizations.id })
      .from(crmOrganizations)
      .where(and(eq(crmOrganizations.id, id), eq(crmOrganizations.orgId, orgId)));
    return Boolean(row);
  }

  applyUpdate(orgId: string, id: number, input: OrganizationUpdateInput) {
    return this.db
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
  }

  async remove(orgId: string, id: number): Promise<boolean> {
    const [deleted] = await this.db
      .delete(crmOrganizations)
      .where(and(eq(crmOrganizations.id, id), eq(crmOrganizations.orgId, orgId)))
      .returning({ id: crmOrganizations.id });
    return Boolean(deleted);
  }

  async wouldCreateCycle(orgId: string, accountId: number, candidateParentId: number): Promise<boolean> {
    if (candidateParentId === accountId) return true;

    const allOrgs = await this.db
      .select({ id: crmOrganizations.id, parentId: crmOrganizations.parentId })
      .from(crmOrganizations)
      .where(eq(crmOrganizations.orgId, orgId));

    const parentMap = new Map(allOrgs.map((o) => [o.id, o.parentId]));

    let currentId: number | null = candidateParentId;
    const visited = new Set<number>();

    while (currentId !== null) {
      if (visited.has(currentId)) return false;
      visited.add(currentId);
      if (currentId === accountId) return true;
      currentId = parentMap.get(currentId) ?? null;
    }

    return false;
  }

  private async getAllDescendantIds(orgId: string, accountId: number): Promise<number[]> {
    const allOrgs = await this.db
      .select({ id: crmOrganizations.id, parentId: crmOrganizations.parentId })
      .from(crmOrganizations)
      .where(eq(crmOrganizations.orgId, orgId));

    const childrenMap = new Map<number, number[]>();
    for (const o of allOrgs) {
      if (o.parentId !== null) {
        const arr = childrenMap.get(o.parentId) ?? [];
        arr.push(o.id);
        childrenMap.set(o.parentId, arr);
      }
    }

    const allIds: number[] = [accountId];
    const queue: number[] = [accountId];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const childId of childrenMap.get(cur) ?? []) {
        if (!allIds.includes(childId)) {
          allIds.push(childId);
          queue.push(childId);
        }
      }
    }

    return allIds;
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
      .where(and(eq(crmOrganizations.orgId, orgId), inArray(crmOrganizations.id, ids)));

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
    return this.cache.cached(
      `crm:org-rollup:${orgId}:${accountId}`,
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
      .where(and(eq(crmOrganizations.orgId, orgId), inArray(crmOrganizations.id, ids)));

    const orgNames = orgRows.map((r) => r.name);

    let totalDeals = 0;
    let openDeals = 0;
    let totalDealValue = 0;

    if (orgNames.length > 0) {
      const dealRows = await this.db
        .select({ stage: deals.stage, value: deals.value })
        .from(deals)
        .where(
          and(
            eq(deals.orgId, orgId),
            or(...orgNames.map((n) => ilike(deals.name, `%${n.replaceAll("%", "\\%")}%`))),
          ),
        )
        .limit(200);

      totalDeals = dealRows.length;
      openDeals = dealRows.filter((d) => !["CLOSED_WON", "CLOSED_LOST"].includes(d.stage)).length;
      totalDealValue = dealRows.reduce((sum, d) => sum + Number(d.value ?? 0), 0);
    }

    const leadCountRows = await this.db
      .select({ count: sql<string>`count(*)` })
      .from(leads)
      .where(
        and(
          eq(leads.orgId, orgId),
          orgNames.length > 0
            ? or(...orgNames.map((n) => ilike(leads.company, `%${n.replaceAll("%", "\\%")}%`)))
            : sql`false`,
        ),
      );

    const totalLeads = Number(leadCountRows[0]?.count ?? 0);

    return { totalContacts, totalDeals, openDeals, totalDealValue, totalLeads };
  }

  getAccountTimeline(orgId: string, accountId: number, limit = 20): Promise<OrgTimelineEvent[]> {
    return this.cache.cached(
      `crm:org-timeline:${orgId}:${accountId}:${limit}`,
      () => this.queryAccountTimeline(orgId, accountId, limit),
      CACHE_TTL.SHORT,
    );
  }

  private async queryAccountTimeline(orgId: string, accountId: number, limit: number): Promise<OrgTimelineEvent[]> {
    const orgRow = await this.db
      .select({ name: crmOrganizations.name, notes: crmOrganizations.notes })
      .from(crmOrganizations)
      .where(and(eq(crmOrganizations.id, accountId), eq(crmOrganizations.orgId, orgId)))
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
        .where(and(eq(leads.orgId, orgId), ilike(leads.company, `%${safeName}%`)))
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
      .where(and(eq(crmOrganizations.id, id), eq(crmOrganizations.orgId, orgId)));

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
      .where(and(eq(leads.orgId, orgId), or(...conditions)))
      .orderBy(leads.createdAt)
      .limit(50);
  }
}
