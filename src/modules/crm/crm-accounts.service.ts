import { Inject, Injectable } from "@nestjs/common";
import { eq, and, sql, inArray, or, ilike } from "drizzle-orm";
import { crmOrganizations, contacts, deals, leads } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";

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

@Injectable()
export class CrmAccountsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async wouldCreateCycle(orgId: string, accountId: number, candidateParentId: number): Promise<boolean> {
    if (candidateParentId === accountId) return true;

    let currentId: number | null = candidateParentId;
    const visited = new Set<number>();

    while (currentId !== null) {
      if (visited.has(currentId)) return false;
      visited.add(currentId);

      if (currentId === accountId) return true;

      const cycleRows: { parentId: number | null }[] = await this.db
        .select({ parentId: crmOrganizations.parentId })
        .from(crmOrganizations)
        .where(and(eq(crmOrganizations.id, currentId), eq(crmOrganizations.orgId, orgId)))
        .limit(1);
      const row: { parentId: number | null } | null = cycleRows[0] ?? null;

      if (!row) break;
      currentId = row.parentId;
    }

    return false;
  }

  async getAllDescendantIds(orgId: string, accountId: number): Promise<number[]> {
    const allIds: number[] = [accountId];
    const queue: number[] = [accountId];

    while (queue.length > 0) {
      const batch = queue.splice(0, 50);
      const children = await this.db
        .select({ id: crmOrganizations.id })
        .from(crmOrganizations)
        .where(
          and(
            eq(crmOrganizations.orgId, orgId),
            sql`${crmOrganizations.parentId} = ANY(ARRAY[${sql.join(batch.map((b) => sql`${b}`), sql`, `)}]::int[])`,
          ),
        );

      for (const child of children) {
        if (!allIds.includes(child.id)) {
          allIds.push(child.id);
          queue.push(child.id);
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

  async getAccountRollup(orgId: string, accountId: number): Promise<OrgRollup> {
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
        );

      totalDeals = dealRows.length;
      openDeals = dealRows.filter((d) => !["WON", "LOST"].includes(d.stage)).length;
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

  async getAccountTimeline(orgId: string, accountId: number, limit = 20): Promise<OrgTimelineEvent[]> {
    const orgRow = await this.db
      .select({ name: crmOrganizations.name, notes: crmOrganizations.notes })
      .from(crmOrganizations)
      .where(and(eq(crmOrganizations.id, accountId), eq(crmOrganizations.orgId, orgId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (!orgRow) return [];

    const events: OrgTimelineEvent[] = [];

    const contactRows = await this.db
      .select({ id: contacts.id, name: contacts.name, createdAt: contacts.createdAt })
      .from(contacts)
      .where(and(eq(contacts.orgId, orgId), eq(contacts.organizationId, accountId)))
      .orderBy(sql`${contacts.createdAt} desc`)
      .limit(limit);

    for (const c of contactRows) {
      events.push({
        id: `contact-${c.id}`,
        date: c.createdAt?.toISOString() ?? new Date().toISOString(),
        type: "contact_created",
        description: `Contact "${c.name}" added to organization`,
        entityId: c.id,
      });
    }

    const dealRows = await this.db
      .select({ id: deals.id, name: deals.name, stage: deals.stage, createdAt: deals.createdAt })
      .from(deals)
      .where(and(eq(deals.orgId, orgId), ilike(deals.name, `%${orgRow.name.replaceAll("%", "\\%")}%`)))
      .orderBy(sql`${deals.createdAt} desc`)
      .limit(limit);

    for (const d of dealRows) {
      events.push({
        id: `deal-${d.id}`,
        date: d.createdAt?.toISOString() ?? new Date().toISOString(),
        type: "deal_created",
        description: `Deal "${d.name}" (${d.stage}) linked`,
        entityId: d.id,
      });
    }

    const leadRows = await this.db
      .select({ id: leads.id, name: leads.name, createdAt: leads.createdAt })
      .from(leads)
      .where(and(eq(leads.orgId, orgId), ilike(leads.company, `%${orgRow.name.replaceAll("%", "\\%")}%`)))
      .orderBy(sql`${leads.createdAt} desc`)
      .limit(limit);

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
}
