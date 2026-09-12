import { NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { glParties, taxRegistrations } from "../../../../db/schema";
import type { DbOrTx } from "../../kernel/sequence.service";
import type { ListPartiesQuery } from "../dto/parties.schemas";
import type { ExternalRef, PartyPage, PartyTaxRegistration } from "../parties.types";

/**
 * Reads of the party master, each on the reader it is handed. Every one
 * re-asserts `org_id`, so a cross-tenant id is simply not found.
 */

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

const SUMMARY_COLUMNS = {
  id: glParties.id,
  bookId: glParties.bookId,
  role: glParties.role,
  displayName: glParties.displayName,
  legalName: glParties.legalName,
  email: glParties.email,
  phone: glParties.phone,
  countryCode: glParties.countryCode,
  defaultCurrency: glParties.defaultCurrency,
  billingRegion: glParties.billingRegion,
  billingCountryCode: glParties.billingCountryCode,
  paymentTermsDays: glParties.paymentTermsDays,
  isActive: glParties.isActive,
} as const;

const DETAIL_COLUMNS = {
  ...SUMMARY_COLUMNS,
  billingLine1: glParties.billingLine1,
  billingLine2: glParties.billingLine2,
  billingCity: glParties.billingCity,
  billingPostalCode: glParties.billingPostalCode,
  shippingLine1: glParties.shippingLine1,
  shippingCity: glParties.shippingCity,
  shippingRegion: glParties.shippingRegion,
  shippingPostalCode: glParties.shippingPostalCode,
  shippingCountryCode: glParties.shippingCountryCode,
  defaultIncomeAccountId: glParties.defaultIncomeAccountId,
  defaultExpenseAccountId: glParties.defaultExpenseAccountId,
  withholdingCode: glParties.withholdingCode,
  notes: glParties.notes,
  externalRefs: glParties.externalRefs,
} as const;

/** One page of a book's parties; the caller resolves which book. */
export async function listPartyPage(
  db: DbOrTx,
  orgId: string,
  bookId: string,
  query: ListPartiesQuery,
): Promise<PartyPage> {
  const page = query.page ?? 1;
  const pageSize = Math.min(query.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  const filters = [
    eq(glParties.orgId, orgId),
    eq(glParties.bookId, bookId),
    isNull(glParties.deletedAt),
  ];
  if (query.role) {
    // "both" satisfies a request for either side, so a company you buy from
    // and sell to shows up in the customer list too.
    filters.push(
      query.role === "both"
        ? eq(glParties.role, "both")
        : or(eq(glParties.role, query.role), eq(glParties.role, "both"))!,
    );
  }
  if (!query.includeInactive) filters.push(eq(glParties.isActive, true));
  if (query.search) {
    const needle = `%${query.search}%`;
    filters.push(
      or(
        ilike(glParties.displayName, needle),
        ilike(glParties.legalName, needle),
        ilike(glParties.email, needle),
      )!,
    );
  }

  const where = and(...filters);

  const [items, [counted]] = await Promise.all([
    db
      .select(SUMMARY_COLUMNS)
      .from(glParties)
      .where(where)
      .orderBy(asc(glParties.displayName), asc(glParties.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: sql<string>`count(*)` }).from(glParties).where(where),
  ]);

  return { items, page, pageSize, total: Number(counted?.total ?? 0) };
}

/** A live party's detail columns, or 404. */
export async function loadPartyDetailRow(tx: DbOrTx, orgId: string, partyId: string) {
  const [row] = await tx
    .select(DETAIL_COLUMNS)
    .from(glParties)
    .where(
      and(eq(glParties.orgId, orgId), eq(glParties.id, partyId), isNull(glParties.deletedAt)),
    )
    .limit(1);
  if (!row) throw new NotFoundException("Party not found");
  return row;
}

/** The oldest live party in the book that carries this external pointer. */
export async function findPartyIdByExternalRef(
  tx: DbOrTx,
  orgId: string,
  bookId: string,
  ref: ExternalRef,
): Promise<string | null> {
  const probe = JSON.stringify([{ system: ref.system, id: ref.id }]);
  const [row] = await tx
    .select({ id: glParties.id })
    .from(glParties)
    .where(
      and(
        eq(glParties.orgId, orgId),
        eq(glParties.bookId, bookId),
        isNull(glParties.deletedAt),
        sql`${glParties.externalRefs} @> ${probe}::jsonb`,
      ),
    )
    .orderBy(asc(glParties.createdAt))
    .limit(1);

  return row ? row.id : null;
}

export async function listPartyRegistrations(
  tx: DbOrTx,
  orgId: string,
  partyId: string,
): Promise<PartyTaxRegistration[]> {
  return tx
    .select({
      id: taxRegistrations.id,
      regime: taxRegistrations.regime,
      number: taxRegistrations.number,
      region: taxRegistrations.region,
      countryCode: taxRegistrations.countryCode,
      isPrimary: taxRegistrations.isPrimary,
      validFrom: taxRegistrations.validFrom,
      validTo: taxRegistrations.validTo,
    })
    .from(taxRegistrations)
    .where(
      and(
        eq(taxRegistrations.orgId, orgId),
        eq(taxRegistrations.ownerType, "party"),
        eq(taxRegistrations.partyId, partyId),
      ),
    )
    .orderBy(desc(taxRegistrations.isPrimary), asc(taxRegistrations.createdAt));
}
