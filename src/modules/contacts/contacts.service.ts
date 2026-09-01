import { Inject, Injectable } from "@nestjs/common";
import { and, asc, gt } from "drizzle-orm";
import { businessParties, contactPartyMap } from "../../db/schema/party";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { toCsv } from "../inventory/import-export/csv.util";
import {
  createMirroredContact,
  createMirroredContacts,
  softDeleteMirroredContacts,
  updateMirroredContact,
} from "../party/party-legacy-contacts";
import type { ContactInsert } from "../party/party-legacy-writer";
import { CONTACT_PARTY_COLUMNS, CONTACT_PARTY_JOIN, contactPartyScope } from "./contact-party-reader";
import { queryContacts, searchContacts, getOneContact } from "./contacts-query";
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
    const hash = `${filters.search ?? ""}:${filters.organizationId ?? ""}:${filters.limit ?? ""}:${filters.cursor ?? ""}`;
    return this.cache.cachedVersioned(
      CACHE_KEYS.contactsListNamespace(orgId),
      hash,
      () => queryContacts(this.db, orgId, filters),
      CACHE_TTL.SHORT,
    );
  }

  search(orgId: string, query: string) {
    return searchContacts(this.db, orgId, query);
  }

  getContact(orgId: string, id: number) {
    return getOneContact(this.db, orgId, id);
  }

  async create(orgId: string, input: CreateInput) {
    await this.planLimits.assertWithinLimit(orgId, "crmContacts");

    const contact = await createMirroredContact(this.db, orgId, {
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
      notes: input.notes,
      leadId: input.leadId,
      dealId: input.dealId,
      tags: input.tags,
    });

    await this.cache.invalidateNamespace(CACHE_KEYS.contactsListNamespace(orgId));
    return contact;
  }

  async update(orgId: string, id: number, input: UpdateInput) {
    const updated = await updateMirroredContact(this.db, orgId, id, {
      ...input,
      updatedAt: new Date(),
    });

    if (!updated) return null;
    await this.cache.invalidateNamespace(CACHE_KEYS.contactsListNamespace(orgId));
    return updated;
  }

  async remove(orgId: string, id: number) {
    await softDeleteMirroredContacts(this.db, orgId, [id]);
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
      notes: row.notes?.trim() || null,
      tags: [],
    }));

    let created = 0;
    let failed = 0;
    for (let start = 0; start < rows.length; start += 100) {
      const result = await this.insertImportChunk(orgId, rows.slice(start, start + 100));
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
    orgId: string,
    rows: ContactInsert[],
  ): Promise<{ created: number; failed: number }> {
    if (rows.length === 0) return { created: 0, failed: 0 };

    try {
      await createMirroredContacts(this.db, orgId, rows, { linkedBy: "contacts:import" });
      return { created: rows.length, failed: 0 };
    } catch {
      if (rows.length === 1) return { created: 0, failed: 1 };

      const midpoint = Math.ceil(rows.length / 2);
      const left = await this.insertImportChunk(orgId, rows.slice(0, midpoint));
      const right = await this.insertImportChunk(orgId, rows.slice(midpoint));
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
          id: CONTACT_PARTY_COLUMNS.id,
          name: CONTACT_PARTY_COLUMNS.name,
          email: CONTACT_PARTY_COLUMNS.email,
          phone: CONTACT_PARTY_COLUMNS.phone,
          title: CONTACT_PARTY_COLUMNS.title,
          company: CONTACT_PARTY_COLUMNS.company,
          department: CONTACT_PARTY_COLUMNS.department,
          createdAt: CONTACT_PARTY_COLUMNS.createdAt,
        })
        .from(contactPartyMap)
        .innerJoin(businessParties, CONTACT_PARTY_JOIN)
        .where(
          and(
            ...contactPartyScope(orgId),
            gt(contactPartyMap.contactId, afterId),
          ),
        )
        .orderBy(asc(contactPartyMap.contactId))
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
