import { Inject, Injectable } from "@nestjs/common";
import { eq, and, asc, sql, count, or, ilike, gt, type SQL } from "drizzle-orm";
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
import { alias } from "drizzle-orm/pg-core";
import { deals } from "../../db/schema";
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
import { crmOrgIdsOfParties, partyIdsOfCrmOrgs } from "../party/party-legacy-employer";
import { leadIdsOfParties } from "../party/party-legacy-associations";
import type { ContactInsert } from "../party/party-legacy-writer";
import {
  CONTACT_PARTY_COLUMNS,
  CONTACT_PARTY_JOIN,
  contactIdIs,
  contactPartyScope,
} from "./contact-party-reader";
import type {
  BulkImportContactsInput,
  CreateInput,
  ListInput,
  UpdateInput,
} from "./dto/contact.schemas";

/**
 * The party behind the lead a contact came from.
 *
 * A second reference to `business_parties` in the same query, so it needs a name
 * of its own. `converted_from_party_id` points straight at it since 0265, so the
 * join is party to party and cannot multiply the row the map produced —
 * `party_id` is the primary key of `business_parties`.
 */
const leadParty = alias(businessParties, "contact_lead_party");

/** The party behind the company a contact works at; see `leadParty`. */
const employerParty = alias(businessParties, "contact_employer_party");

/** What the list and the detail read share, shaped as the relations they replaced. */
interface ContactAssociationRow {
  leadId: number | null;
  leadName: string | null;
  dealId: number | null;
  dealName: string | null;
  organizationId: number | null;
  crmOrganizationName: string | null;
}

function associationsOf(row: ContactAssociationRow) {
  return {
    lead: row.leadId !== null ? { id: row.leadId, name: row.leadName } : null,
    deal: row.dealId !== null ? { id: row.dealId, name: row.dealName } : null,
  };
}

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
      () => this.queryContacts(orgId, filters),
      CACHE_TTL.SHORT,
    );
  }

  /**
   * The base every contact read starts from.
   *
   * `contact_party_map` leads and the party is joined onto it, so the numeric id
   * every URL and vCard still speaks stays selectable while every rendered field
   * comes from `business_parties`. The three associations the card shows are the
   * party's own now -- `converted_from_party_id`, `primary_deal_id` and
   * `employer_party_id`, from 0262 and 0265 -- so the legacy row is not joined at
   * all.
   *
   * Only the *names* are joined here, and only ever party-to-party or onto
   * `deals.id`: both are primary keys, so no join below can multiply the row the
   * map produced. The two association **ids** the response carries are integers in
   * the legacy id space, and reaching them means `lead_party_map` and
   * `crm_org_party_map`, whose `party_id` side is deliberately NOT unique -- after
   * a merge one surviving party answers to several legacy ids. Joining those here
   * would duplicate a contact on the list and inflate `total`, so they are
   * resolved per page in `withAssociationIds` instead, through the same
   * lowest-id-wins rule the mirror writes them with.
   */
  private contactBase(orgId: string) {
    return this.db
      .select({
        id: CONTACT_PARTY_COLUMNS.id,
        orgId: CONTACT_PARTY_COLUMNS.orgId,
        name: CONTACT_PARTY_COLUMNS.name,
        email: CONTACT_PARTY_COLUMNS.email,
        phone: CONTACT_PARTY_COLUMNS.phone,
        title: CONTACT_PARTY_COLUMNS.title,
        department: CONTACT_PARTY_COLUMNS.department,
        company: CONTACT_PARTY_COLUMNS.company,
        linkedinUrl: CONTACT_PARTY_COLUMNS.linkedinUrl,
        twitterUrl: CONTACT_PARTY_COLUMNS.twitterUrl,
        websiteUrl: CONTACT_PARTY_COLUMNS.websiteUrl,
        avatarUrl: CONTACT_PARTY_COLUMNS.avatarUrl,
        notes: CONTACT_PARTY_COLUMNS.notes,
        tags: CONTACT_PARTY_COLUMNS.tags,
        deletedAt: CONTACT_PARTY_COLUMNS.deletedAt,
        createdAt: CONTACT_PARTY_COLUMNS.createdAt,
        updatedAt: CONTACT_PARTY_COLUMNS.updatedAt,
        dealId: businessParties.primaryDealId,
        /*
         * Always null, and kept rather than dropped so the response shape does not
         * change. `contacts.merged_into_id` has exactly one writer -- the contact
         * merge -- and it sets `deleted_at` in the same statement, while
         * `contactPartyScope` excludes deleted parties. So no read through this
         * file has ever been able to see a non-null value, and the legacy join
         * that produced it was the last thing keeping this file on the ratchet.
         * `party_merges` is where a merge is recorded now.
         */
        mergedIntoId: sql<number | null>`null::integer`,
        leadPartyId: businessParties.convertedFromPartyId,
        employerPartyId: businessParties.employerPartyId,
        leadName: leadParty.name,
        dealName: deals.name,
        crmOrganizationName: employerParty.name,
      })
      .from(contactPartyMap)
      .innerJoin(businessParties, CONTACT_PARTY_JOIN)
      // Every association join names the tenant as a literal rather than
      // correlating it, so a party or deal id shared across organisations cannot
      // reach the wrong row and the planner can push the constant into each index.
      .leftJoin(
        leadParty,
        and(
          eq(leadParty.partyId, businessParties.convertedFromPartyId),
          eq(leadParty.organizationId, orgId),
        ),
      )
      .leftJoin(
        employerParty,
        and(
          eq(employerParty.partyId, businessParties.employerPartyId),
          eq(employerParty.organizationId, orgId),
        ),
      )
      .leftJoin(deals, and(eq(deals.id, businessParties.primaryDealId), eq(deals.orgId, orgId)));
  }

  /**
   * The two association ids, resolved a page at a time.
   *
   * `lead_party_map` and `crm_org_party_map` are keyed by their legacy id, not by
   * `party_id`, so this cannot be a join without risking a duplicated row; see
   * `contactBase`. Two queries per page, batched over the whole page, and both go
   * through the same helpers the mirror uses to write the legacy columns -- so the
   * ids a caller reads here are the ids on the legacy row, by construction rather
   * than by coincidence.
   */
  private async withAssociationIds<
    T extends { leadPartyId: string | null; employerPartyId: string | null },
  >(orgId: string, rows: T[]): Promise<(Omit<T, "leadPartyId" | "employerPartyId"> & {
    leadId: number | null;
    organizationId: number | null;
  })[]> {
    const leadPartyIds = rows.map((row) => row.leadPartyId).filter((id): id is string => id !== null);
    const employerPartyIds = rows
      .map((row) => row.employerPartyId)
      .filter((id): id is string => id !== null);

    const [leadIds, crmOrgIds] = await Promise.all([
      leadIdsOfParties(this.db, orgId, leadPartyIds),
      crmOrgIdsOfParties(this.db, orgId, employerPartyIds),
    ]);

    return rows.map(({ leadPartyId, employerPartyId, ...rest }) => ({
      ...rest,
      leadId: leadPartyId ? (leadIds.get(leadPartyId) ?? null) : null,
      organizationId: employerPartyId ? (crmOrgIds.get(employerPartyId) ?? null) : null,
    }));
  }

  private listConditions(orgId: string, filters: ListInput, employerPartyId: string | null): SQL[] {
    const conditions: SQL[] = [...contactPartyScope(orgId)];
    if (employerPartyId) {
      conditions.push(eq(businessParties.employerPartyId, employerPartyId));
    }
    if (filters.search) {
      const s = `%${filters.search}%`;
      conditions.push(
        or(
          sql`${CONTACT_PARTY_COLUMNS.name} ILIKE ${s}`,
          sql`${CONTACT_PARTY_COLUMNS.email} ILIKE ${s}`,
          sql`${CONTACT_PARTY_COLUMNS.company} ILIKE ${s}`,
        )!,
      );
    }
    return conditions;
  }

  private async queryContacts(orgId: string, filters: ListInput) {
    const employerPartyId = filters.organizationId
      ? ((await partyIdsOfCrmOrgs(this.db, orgId, [filters.organizationId])).get(
          filters.organizationId,
        ) ?? null)
      : null;
    if (filters.organizationId && !employerPartyId) return { items: [], total: 0, hasMore: false, nextCursor: null };

    const after = decodeCursor(filters.cursor);
    const conditions = this.listConditions(orgId, filters, employerPartyId);
    const afterId = after ? Number(after.id) : Number.NaN;
    if (after && !Number.isNaN(afterId)) {
      const keyset = or(
        gt(CONTACT_PARTY_COLUMNS.name, after.sortValue),
        and(
          eq(CONTACT_PARTY_COLUMNS.name, after.sortValue),
          gt(CONTACT_PARTY_COLUMNS.id, afterId),
        ),
      );
      if (keyset) conditions.push(keyset);
    }
    const whereClause = and(...conditions);
    const limit = filters.limit ?? 50;

    const [countResult, rows] = await Promise.all([
      after === null
        ? this.db
            .select({ count: count() })
            .from(contactPartyMap)
            .innerJoin(businessParties, CONTACT_PARTY_JOIN)
            .where(and(...this.listConditions(orgId, filters, employerPartyId)))
        : Promise.resolve(null),
      this.contactBase(orgId)
        .where(whereClause)
        .orderBy(asc(CONTACT_PARTY_COLUMNS.name), asc(CONTACT_PARTY_COLUMNS.id))
        .limit(limit + 1),
    ]);

    const cursorPage = buildCursorPage(rows, limit, (r) => ({
      sortValue: r.name,
      id: String(r.id),
    }));
    const items = (await this.withAssociationIds(orgId, cursorPage.data)).map(
      ({ leadName, dealName, crmOrganizationName, ...contact }) => ({
        ...contact,
        ...associationsOf({ ...contact, leadName, dealName, crmOrganizationName }),
      }),
    );

    return {
      items,
      total: countResult ? Number(countResult[0]?.count ?? 0) : undefined,
      hasMore: cursorPage.pagination.hasMore,
      nextCursor: cursorPage.pagination.nextCursor,
    };
  }

  search(orgId: string, query: string) {
    const q = `%${query}%`;
    return this.db
      .select({
        id: CONTACT_PARTY_COLUMNS.id,
        name: CONTACT_PARTY_COLUMNS.name,
        email: CONTACT_PARTY_COLUMNS.email,
        phone: CONTACT_PARTY_COLUMNS.phone,
        company: CONTACT_PARTY_COLUMNS.company,
        jobTitle: CONTACT_PARTY_COLUMNS.title,
        image: CONTACT_PARTY_COLUMNS.avatarUrl,
      })
      .from(contactPartyMap)
      .innerJoin(businessParties, CONTACT_PARTY_JOIN)
      .where(
        and(
          ...contactPartyScope(orgId),
          or(
            ilike(CONTACT_PARTY_COLUMNS.name, q),
            ilike(CONTACT_PARTY_COLUMNS.email, q),
            ilike(CONTACT_PARTY_COLUMNS.phone, q),
          ),
        ),
      )
      // Twenty of however many matched; the id says which twenty rather than
      // the heap order, which reading through the map changes.
      .orderBy(asc(CONTACT_PARTY_COLUMNS.name), asc(CONTACT_PARTY_COLUMNS.id))
      .limit(20);
  }

  async getContact(orgId: string, id: number) {
    const [base] = await this.contactBase(orgId)
      .where(and(...contactPartyScope(orgId), contactIdIs(id)))
      .limit(1);
    if (!base) return undefined;

    const [row] = await this.withAssociationIds(orgId, [base]);
    if (!row) return undefined;

    const { leadName, dealName, crmOrganizationName, ...contact } = row;
    return {
      ...contact,
      // The three association objects the relational read used to hydrate, with
      // the same two public columns each and nothing else.
      crmOrganization:
        contact.organizationId !== null
          ? { id: contact.organizationId, name: crmOrganizationName }
          : null,
      ...associationsOf({ ...contact, leadName, dealName, crmOrganizationName }),
    };
  }

  async create(orgId: string, input: CreateInput) {
    await this.planLimits.assertWithinLimit(orgId, "crmContacts");

    // The party is written first and this row derived from it; see
    // `party-legacy-writer`. The values below are still in `contacts`' vocabulary
    // because that is what the DTO speaks -- the writer translates once.
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
      // Keep failure isolation sequential so a pathological file cannot fan out
      // into hundreds of concurrent transactions.
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
            // The keyset stays on the map's own id: it is the primary key of
            // `(organization_id, contact_id)`, so it is unique per tenant and a
            // page can neither repeat nor skip.
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
