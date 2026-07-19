import { Inject, Injectable } from "@nestjs/common";
import { eq, and, sql, count, or, ilike, isNull } from "drizzle-orm";
import { contacts } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { PlanLimitsService } from "../billing/plan-limits.service";
import { toCsv } from "../inv-import-export/csv.util";
import type {
  BulkImportContactsInput,
  CreateInput,
  ListInput,
  UpdateInput,
} from "./dto/contact.schemas";

@Injectable()
export class ContactsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  list(orgId: string, filters: ListInput) {
    const hash = `${filters.search ?? ""}:${filters.organizationId ?? ""}:${filters.limit ?? ""}:${filters.offset ?? ""}`;
    return this.cache.cached(
      CACHE_KEYS.contactsList(orgId, hash),
      () => this.queryContacts(orgId, filters),
      CACHE_TTL.SHORT,
    );
  }

  private async queryContacts(orgId: string, filters: ListInput) {
    const conditions = [eq(contacts.orgId, orgId), isNull(contacts.deletedAt)];
    if (filters.organizationId) {
      conditions.push(eq(contacts.organizationId, filters.organizationId));
    }
    if (filters.search) {
      const s = `%${filters.search}%`;
      conditions.push(
        or(
          sql`${contacts.name} ILIKE ${s}`,
          sql`${contacts.email} ILIKE ${s}`,
          sql`${contacts.company} ILIKE ${s}`,
        )!,
      );
    }

    const whereClause = and(...conditions);
    const [totalResult, items] = await Promise.all([
      this.db.select({ count: count() }).from(contacts).where(whereClause),
      this.db.query.contacts.findMany({
        where: whereClause,
        with: {
          lead: { columns: { id: true, name: true } },
          deal: { columns: { id: true, name: true } },
        },
        orderBy: contacts.name,
        limit: filters.limit ?? 50,
        offset: filters.offset ?? 0,
      }),
    ]);

    return { items, total: totalResult[0]?.count ?? 0 };
  }

  search(orgId: string, query: string) {
    const q = `%${query}%`;
    return this.db
      .select({
        id: contacts.id,
        name: contacts.name,
        email: contacts.email,
        phone: contacts.phone,
        company: contacts.company,
        jobTitle: contacts.title,
        image: contacts.avatarUrl,
      })
      .from(contacts)
      .where(
        and(
          eq(contacts.orgId, orgId),
          isNull(contacts.deletedAt),
          or(
            ilike(contacts.name, q),
            ilike(contacts.email, q),
            ilike(contacts.phone, q),
          ),
        ),
      )
      .limit(20);
  }

  getContact(orgId: string, id: number) {
    return this.db.query.contacts.findFirst({
      where: and(eq(contacts.id, id), eq(contacts.orgId, orgId), isNull(contacts.deletedAt)),
      with: { crmOrganization: true, lead: true, deal: true },
    });
  }

  async create(orgId: string, input: CreateInput) {
    await this.planLimits.assertWithinLimit(orgId, "crmContacts");

    const [contact] = await this.db
      .insert(contacts)
      .values({
        orgId,
        name: input.name,
        email: input.email,
        phone: input.phone,
        title: input.title,
        department: input.department,
        company: input.company,
        organizationId: input.organizationId,
        linkedinUrl: input.linkedinUrl,
        twitterUrl: input.twitterUrl,
        websiteUrl: input.websiteUrl,
        leadId: input.leadId,
        dealId: input.dealId,
        tags: input.tags,
      })
      .returning();

    await this.cache.invalidatePattern(`crm:contacts:list:${orgId}:*`);
    return contact;
  }

  async update(orgId: string, id: number, input: UpdateInput) {
    const [updated] = await this.db
      .update(contacts)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(contacts.id, id), eq(contacts.orgId, orgId)))
      .returning();

    if (!updated) return null;
    await this.cache.invalidatePattern(`crm:contacts:list:${orgId}:*`);
    return updated;
  }

  async remove(orgId: string, id: number) {
    await this.db
      .update(contacts)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(contacts.id, id), eq(contacts.orgId, orgId)));
    await this.cache.invalidatePattern(`crm:contacts:list:${orgId}:*`);
    return { success: true };
  }

  async bulkImport(orgId: string, input: BulkImportContactsInput) {
    await this.planLimits.assertWithinLimit(orgId, "crmContacts", input.contacts.length);

    let created = 0;
    let failed = 0;

    for (const row of input.contacts) {
      try {
        const email = row.email?.trim() || null;
        await this.db.insert(contacts).values({
          orgId,
          name: row.name.trim(),
          email: email || null,
          phone: row.phone?.trim() || null,
          company: row.company?.trim() || null,
          title: row.title?.trim() || null,
          tags: [],
        });
        created++;
      } catch {
        failed++;
      }
    }

    if (created > 0) {
      await this.cache.invalidatePattern(`crm:contacts:list:${orgId}:*`);
    }

    return { created, failed };
  }

  async exportCsv(orgId: string): Promise<string> {
    const rows = await this.db
      .select({
        id: contacts.id,
        name: contacts.name,
        email: contacts.email,
        phone: contacts.phone,
        title: contacts.title,
        company: contacts.company,
        department: contacts.department,
        createdAt: contacts.createdAt,
      })
      .from(contacts)
      .where(and(eq(contacts.orgId, orgId), isNull(contacts.deletedAt)))
      .orderBy(contacts.name);

    const headers = [
      "id",
      "name",
      "email",
      "phone",
      "title",
      "company",
      "department",
      "createdAt",
    ];
    return toCsv(
      headers,
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email ?? "",
        phone: r.phone ?? "",
        title: r.title ?? "",
        company: r.company ?? "",
        department: r.department ?? "",
        createdAt: r.createdAt?.toISOString() ?? "",
      })),
    );
  }
}
