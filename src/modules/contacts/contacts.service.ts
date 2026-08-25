import { Inject, Injectable } from "@nestjs/common";
import { eq, and, asc, sql, count, or, ilike, gt, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { contacts, crmOrganizations, deals } from "../../db/schema";
import { businessParties, contactPartyMap, leadPartyMap } from "../../db/schema/party";
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
 * of its own. The lead's *name* is a party field now, and the card has always
 * shown it -- so the association id comes from `contacts.lead_id` and the label
 * comes from the party that id maps to, rather than from the `leads` mirror.
 */
const leadParty = alias(businessParties, "contact_lead_party");

/**
 * The legacy row behind a mapped contact, for its association columns only.
 *
 * `organization_id`, `lead_id` and `deal_id` are legacy-owned per
 * `party-mirror-fields.ts` — a party's employer should be another party, and
 * nothing gives `crm_organizations` parties to point at yet. Tenant on both
 * sides: `contacts` carries a `(org_id, id)` unique constraint, so the join is
 * one-to-one and cannot multiply the rows the map produced.
 */
const CONTACT_LEGACY_JOIN: SQL = and(
  eq(contacts.id, contactPartyMap.contactId),
  eq(contacts.orgId, contactPartyMap.organizationId),
)!;

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
    const hash = `${filters.search ?? ""}:${filters.organizationId ?? ""}:${filters.limit ?? ""}:${filters.offset ?? ""}`;
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
   * comes from `business_parties`. `contacts` is joined for its association
   * columns only -- `organization_id`, `lead_id`, `deal_id` -- which the merged
   * model has nowhere to put yet.
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
        tags: CONTACT_PARTY_COLUMNS.tags,
        deletedAt: CONTACT_PARTY_COLUMNS.deletedAt,
        createdAt: CONTACT_PARTY_COLUMNS.createdAt,
        updatedAt: CONTACT_PARTY_COLUMNS.updatedAt,
        organizationId: contacts.organizationId,
        leadId: contacts.leadId,
        dealId: contacts.dealId,
        mergedIntoId: contacts.mergedIntoId,
        leadName: leadParty.name,
        dealName: deals.name,
        crmOrganizationName: crmOrganizations.name,
      })
      .from(contactPartyMap)
      .innerJoin(businessParties, CONTACT_PARTY_JOIN)
      .innerJoin(contacts, CONTACT_LEGACY_JOIN)
      // Every association join names the tenant as a literal rather than
      // correlating it, so a numeric id shared across organisations cannot reach
      // the wrong row and the planner can push the constant into each index.
      .leftJoin(
        leadPartyMap,
        and(eq(leadPartyMap.leadId, contacts.leadId), eq(leadPartyMap.organizationId, orgId)),
      )
      .leftJoin(
        leadParty,
        and(eq(leadParty.partyId, leadPartyMap.partyId), eq(leadParty.organizationId, orgId)),
      )
      .leftJoin(deals, and(eq(deals.id, contacts.dealId), eq(deals.orgId, orgId)))
      .leftJoin(
        crmOrganizations,
        and(eq(crmOrganizations.id, contacts.organizationId), eq(crmOrganizations.orgId, orgId)),
      );
  }

  private listConditions(orgId: string, filters: ListInput): SQL[] {
    const conditions: SQL[] = [...contactPartyScope(orgId)];
    if (filters.organizationId) {
      conditions.push(eq(contacts.organizationId, filters.organizationId));
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
    const conditions = this.listConditions(orgId, filters);
    const whereClause = and(...conditions);
    const [totalResult, rows] = await Promise.all([
      this.db
        .select({ count: count() })
        .from(contactPartyMap)
        .innerJoin(businessParties, CONTACT_PARTY_JOIN)
        .innerJoin(contacts, CONTACT_LEGACY_JOIN)
        .where(whereClause),
      this.contactBase(orgId)
        .where(whereClause)
        // Names repeat, and this list pages by offset -- without a unique
        // tiebreaker two people called "John Smith" can appear on both page one
        // and page two while somebody else appears on neither.
        .orderBy(asc(CONTACT_PARTY_COLUMNS.name), asc(CONTACT_PARTY_COLUMNS.id))
        .limit(filters.limit ?? 50)
        .offset(filters.offset ?? 0),
    ]);

    const items = rows.map(({ leadName, dealName, crmOrganizationName, ...contact }) => ({
      ...contact,
      ...associationsOf({ ...contact, leadName, dealName, crmOrganizationName }),
    }));

    return { items, total: totalResult[0]?.count ?? 0 };
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
    const [row] = await this.contactBase(orgId)
      .where(and(...contactPartyScope(orgId), contactIdIs(id)))
      .limit(1);
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
    rows: (typeof contacts.$inferInsert)[],
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
