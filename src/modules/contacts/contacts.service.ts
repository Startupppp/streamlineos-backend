import { Inject, Injectable } from "@nestjs/common";
import { eq, and, sql, count, or, ilike, isNull, gt } from "drizzle-orm";
import { contacts } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { toCsv } from "../inventory/import-export/csv.util";
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
    return this.cache.cachedVersioned(
      CACHE_KEYS.contactsListNamespace(orgId),
      hash,
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
      with: {
        crmOrganization: { columns: { id: true, name: true } },
        lead: { columns: { id: true, name: true } },
        deal: { columns: { id: true, name: true } },
      },
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

    await this.cache.invalidateNamespace(CACHE_KEYS.contactsListNamespace(orgId));
    return contact;
  }

  async update(orgId: string, id: number, input: UpdateInput) {
    const [updated] = await this.db
      .update(contacts)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(contacts.id, id), eq(contacts.orgId, orgId)))
      .returning();

    if (!updated) return null;
    await this.cache.invalidateNamespace(CACHE_KEYS.contactsListNamespace(orgId));
    return updated;
  }

  async remove(orgId: string, id: number) {
    await this.db
      .update(contacts)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(contacts.id, id), eq(contacts.orgId, orgId)));
    await this.cache.invalidateNamespace(CACHE_KEYS.contactsListNamespace(orgId));
    return { success: true };
  }

  async bulkImport(orgId: string, input: BulkImportContactsInput) {
    await this.planLimits.assertWithinLimit(orgId, "crmContacts", input.contacts.length);

    const rows = input.contacts.map((row) => ({
      orgId,
      name: row.name.trim(),
      email: row.email?.trim() || null,
      phone: row.phone?.trim() || null,
      company: row.company?.trim() || null,
      title: row.title?.trim() || null,
      tags: [],
    }));

    let created = 0;
    let failed = 0;
    for (let start = 0; start < rows.length; start += 100) {
      const result = await this.insertImportChunk(rows.slice(start, start + 100));
      created += result.created;
      failed += result.failed;
    }

    if (created > 0) {
      await this.cache.invalidateNamespace(CACHE_KEYS.contactsListNamespace(orgId));
    }

    return { created, failed };
  }

  /**
   * Bulk-insert the common success path while retaining row-level partial failure
   * semantics. A rejected batch is bisected until only the invalid row remains.
   */
  private async insertImportChunk(
    rows: (typeof contacts.$inferInsert)[],
  ): Promise<{ created: number; failed: number }> {
    if (rows.length === 0) return { created: 0, failed: 0 };

    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(contacts).values(rows);
      });
      return { created: rows.length, failed: 0 };
    } catch {
      if (rows.length === 1) return { created: 0, failed: 1 };

      const midpoint = Math.ceil(rows.length / 2);
      // Keep failure isolation sequential so a pathological file cannot fan out
      // into hundreds of concurrent transactions.
      const left = await this.insertImportChunk(rows.slice(0, midpoint));
      const right = await this.insertImportChunk(rows.slice(midpoint));
      return {
        created: left.created + right.created,
        failed: left.failed + right.failed,
      };
    }
  }

  async *exportCsvChunks(orgId: string): AsyncGenerator<string> {
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
    yield toCsv(headers, []);

    const pageSize = 500;
    let afterId = 0;
    for (;;) {
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
        .where(
          and(
            eq(contacts.orgId, orgId),
            isNull(contacts.deletedAt),
            gt(contacts.id, afterId),
          ),
        )
        .orderBy(contacts.id)
        .limit(pageSize);
      if (rows.length === 0) return;

      const pageCsv = toCsv(headers, rows.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email ?? "",
        phone: r.phone ?? "",
        title: r.title ?? "",
        company: r.company ?? "",
        department: r.department ?? "",
        createdAt: r.createdAt?.toISOString() ?? "",
      })));
      yield `\n${pageCsv.slice(pageCsv.indexOf("\n") + 1)}`;
      afterId = rows[rows.length - 1]!.id;
      if (rows.length < pageSize) return;
    }
  }
}
