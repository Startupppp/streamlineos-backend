import { Inject, Injectable } from "@nestjs/common";
import { eq, and, desc, ilike, sql, or, inArray } from "drizzle-orm";
import { crmOrganizations, contacts, leads } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import { CrmAccountsService } from "./crm-accounts.service";
import type { OrganizationCreateInput, OrganizationUpdateInput } from "./dto/crm.schemas";

export type OrgCycle = { error: "cycle" };
export type OrgNotFound = { error: "not_found" };

export function isOrgCycle(value: unknown): value is OrgCycle {
  return typeof value === "object" && value !== null && "error" in value && (value as { error: unknown }).error === "cycle";
}

export function isOrgNotFound(value: unknown): value is OrgNotFound {
  return typeof value === "object" && value !== null && "error" in value && (value as { error: unknown }).error === "not_found";
}

function escapeLike(input: string): string {
  return input.replaceAll("%", "\\%").replaceAll("_", "\\_");
}

@Injectable()
export class CrmOrganizationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly accounts: CrmAccountsService,
  ) {}

  list(orgId: string, page: number, pageSize: number, search: string) {
    const searchTerm = search.trim();
    const offset = (page - 1) * pageSize;
    const key = `crm:organizations:list:${orgId}:${page}:${pageSize}:${searchTerm}`;

    return this.cache.cached(
      key,
      async () => {
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
            .limit(pageSize)
            .offset(offset),
          this.db
            .select({ count: sql<number>`count(*)` })
            .from(crmOrganizations)
            .where(where)
            .then((rows) => rows[0]),
        ]);

        const totalCount = Number(countRow?.count ?? 0);
        const totalPages = totalCount === 0 ? 0 : Math.ceil(totalCount / pageSize);

        return { organizations, totalCount, page, totalPages };
      },
      CACHE_TTL.SHORT,
    );
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

  async getDetail(orgId: string, id: number) {
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

  async update(orgId: string, id: number, input: OrganizationUpdateInput) {
    const [existing] = await this.db
      .select({ id: crmOrganizations.id })
      .from(crmOrganizations)
      .where(and(eq(crmOrganizations.id, id), eq(crmOrganizations.orgId, orgId)));

    if (!existing) return { error: "not_found" } as OrgNotFound;

    if (input.parentId !== undefined && input.parentId !== null) {
      const cycle = await this.accounts.wouldCreateCycle(orgId, id, input.parentId);
      if (cycle) return { error: "cycle" } as OrgCycle;
    }

    const [updated] = await this.db
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
      .returning();

    await this.cache.invalidatePattern(`crm:organizations:list:${orgId}:*`);
    return updated;
  }

  async remove(orgId: string, id: number) {
    const [existing] = await this.db
      .select({ id: crmOrganizations.id })
      .from(crmOrganizations)
      .where(and(eq(crmOrganizations.id, id), eq(crmOrganizations.orgId, orgId)));

    if (!existing) return null;

    await this.db
      .delete(crmOrganizations)
      .where(and(eq(crmOrganizations.id, id), eq(crmOrganizations.orgId, orgId)));

    await this.cache.invalidatePattern(`crm:organizations:list:${orgId}:*`);
    return { success: true };
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
