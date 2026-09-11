import { eq, and, asc, sql, count, or, ilike, gt, type SQL } from "drizzle-orm";
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
import { alias } from "drizzle-orm/pg-core";
import { deals } from "../../db/schema";
import { businessParties, contactPartyMap } from "../../db/schema/party";
import { type Db } from "../../db/drizzle.module";
import { crmOrgIdsOfParties, partyIdsOfCrmOrgs } from "../party/party-legacy-employer";
import { leadIdsOfParties } from "../party/party-legacy-associations";
import {
  CONTACT_PARTY_COLUMNS,
  CONTACT_PARTY_JOIN,
  canonicalContactOnly,
  contactIdIs,
  contactPartyScope,
  CONTACT_PARTY_SCOPE,
} from "./contact-party-reader";
import type { ScopedRead } from "../access/scoped-read";
import type { ListInput } from "./dto/contact.schemas";

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

export function contactBase(db: Db, orgId: string) {
  return db
    .select({
      id: CONTACT_PARTY_COLUMNS.id,
      /*
       * The record this contact id is an alias for.
       *
       * Carried because merging two customer records is a party-grain
       * operation — `POST /party/merges` — and the screens that offer it speak
       * contact ids. Translating in the client would mean a second round trip
       * per row through a map the projection is already standing on.
       */
      partyId: CONTACT_PARTY_COLUMNS.partyId,
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
      mergedIntoId: sql<number | null>`null::integer`,
      leadPartyId: businessParties.convertedFromPartyId,
      employerPartyId: businessParties.employerPartyId,
      leadName: leadParty.name,
      dealName: deals.name,
      crmOrganizationName: employerParty.name,
    })
    .from(contactPartyMap)
    .innerJoin(businessParties, CONTACT_PARTY_JOIN)
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
 */
export async function withAssociationIds<
  T extends { leadPartyId: string | null; employerPartyId: string | null },
>(db: Db, orgId: string, rows: T[]): Promise<(Omit<T, "leadPartyId" | "employerPartyId"> & {
  leadId: number | null;
  organizationId: number | null;
})[]> {
  const leadPartyIds = rows.map((row) => row.leadPartyId).filter((id): id is string => id !== null);
  const employerPartyIds = rows
    .map((row) => row.employerPartyId)
    .filter((id): id is string => id !== null);

  const [leadIds, crmOrgIds] = await Promise.all([
    leadIdsOfParties(db, orgId, leadPartyIds),
    crmOrgIdsOfParties(db, orgId, employerPartyIds),
  ]);

  return rows.map(({ leadPartyId, employerPartyId, ...rest }) => ({
    ...rest,
    leadId: leadPartyId ? (leadIds.get(leadPartyId) ?? null) : null,
    organizationId: employerPartyId ? (crmOrgIds.get(employerPartyId) ?? null) : null,
  }));
}

export function listConditions(orgId: string, filters: ListInput, employerPartyId: string | null): SQL[] {
  // Canonical rows only: a party that answers to several contact ids after a
  // merge is one person, and the list is where showing it twice would read as
  // the merge having failed. See `canonicalContactOnly`.
  const conditions: SQL[] = [...contactPartyScope(orgId), canonicalContactOnly(orgId)];
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

export async function queryContacts(db: Db, read: ScopedRead, filters: ListInput) {
  const orgId = read.orgId;
  const employerPartyId = filters.organizationId
    ? ((await partyIdsOfCrmOrgs(db, orgId, [filters.organizationId])).get(
        filters.organizationId,
      ) ?? null)
    : null;
  if (filters.organizationId && !employerPartyId) return { items: [], total: 0, hasMore: false, nextCursor: null };

  const after = decodeCursor(filters.cursor);
  const afterId = after ? Number(after.id) : Number.NaN;
  const keyset =
    after && !Number.isNaN(afterId)
      ? or(
          gt(CONTACT_PARTY_COLUMNS.name, after.sortValue),
          and(
            eq(CONTACT_PARTY_COLUMNS.name, after.sortValue),
            gt(CONTACT_PARTY_COLUMNS.id, afterId),
          ),
        )
      : undefined;
  const limit = filters.limit ?? 50;
  const domain = listConditions(orgId, filters, employerPartyId);

  const scopedCount = read.compose(
    { tenant: businessParties.organizationId, scope: CONTACT_PARTY_SCOPE, and: domain },
    (where) => where.sql,
    () => null,
  );
  const scopedList = read.compose(
    { tenant: businessParties.organizationId, scope: CONTACT_PARTY_SCOPE, and: [...domain, keyset] },
    (where) => where.sql,
    () => null,
  );
  if (scopedList === null || scopedCount === null)
    return { items: [], total: 0, hasMore: false, nextCursor: null };

  const [countResult, rows] = await Promise.all([
    after === null
      ? db
          .select({ count: count() })
          .from(contactPartyMap)
          .innerJoin(businessParties, CONTACT_PARTY_JOIN)
          .where(scopedCount)
      : Promise.resolve(null),
    contactBase(db, orgId)
      .where(scopedList)
      .orderBy(asc(CONTACT_PARTY_COLUMNS.name), asc(CONTACT_PARTY_COLUMNS.id))
      .limit(limit + 1),
  ]);

  const cursorPage = buildCursorPage(rows, limit, (r) => ({
    sortValue: r.name,
    id: String(r.id),
  }));
  const items = (await withAssociationIds(db, orgId, cursorPage.data)).map(
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

export function searchContacts(db: Db, read: ScopedRead, query: string) {
  const q = `%${query}%`;
  return read.read(
    {
      tenant: businessParties.organizationId,
      scope: CONTACT_PARTY_SCOPE,
      and: [
        eq(contactPartyMap.organizationId, read.orgId),
        // One row per party, the same rule the list applies.
        canonicalContactOnly(read.orgId),
        or(
          ilike(CONTACT_PARTY_COLUMNS.name, q),
          ilike(CONTACT_PARTY_COLUMNS.email, q),
          ilike(CONTACT_PARTY_COLUMNS.phone, q),
        ),
      ],
    },
    ({ sql: where }) => db
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
    .where(where)
    .orderBy(asc(CONTACT_PARTY_COLUMNS.name), asc(CONTACT_PARTY_COLUMNS.id))
    .limit(20),
    () => [],
  );
}

export async function getOneContact(db: Db, orgId: string, id: number) {
  const [base] = await contactBase(db, orgId)
    .where(and(...contactPartyScope(orgId), contactIdIs(id)))
    .limit(1);
  if (!base) return undefined;

  const [row] = await withAssociationIds(db, orgId, [base]);
  if (!row) return undefined;

  const { leadName, dealName, crmOrganizationName, ...contact } = row;
  return {
    ...contact,
    crmOrganization:
      contact.organizationId !== null
        ? { id: contact.organizationId, name: crmOrganizationName }
        : null,
    ...associationsOf({ ...contact, leadName, dealName, crmOrganizationName }),
  };
}
