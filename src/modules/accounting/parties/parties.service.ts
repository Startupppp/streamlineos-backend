import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { glParties, taxRegistrations, type TaxRegime } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { BooksService } from "../kernel/books.service";
import type { DbOrTx } from "../kernel/sequence.service";
import type {
  CreatePartyInput,
  CreateTaxRegistrationInput,
  ListPartiesQuery,
  UpdatePartyInput,
} from "./dto/parties.schemas";

/** A pointer back at the record that owns this identity elsewhere. */
export interface ExternalRef {
  system: string;
  id: string;
}

export interface PartySummary {
  id: string;
  bookId: string;
  role: "customer" | "vendor" | "both";
  displayName: string;
  legalName: string | null;
  email: string | null;
  phone: string | null;
  countryCode: string;
  defaultCurrency: string;
  billingRegion: string | null;
  billingCountryCode: string | null;
  paymentTermsDays: number;
  isActive: boolean;
}

export interface PartyDetail extends PartySummary {
  billingLine1: string | null;
  billingLine2: string | null;
  billingCity: string | null;
  billingPostalCode: string | null;
  shippingLine1: string | null;
  shippingCity: string | null;
  shippingRegion: string | null;
  shippingPostalCode: string | null;
  shippingCountryCode: string | null;
  defaultIncomeAccountId: string | null;
  defaultExpenseAccountId: string | null;
  withholdingCode: string | null;
  notes: string | null;
  externalRefs: ExternalRef[];
  taxRegistrations: PartyTaxRegistration[];
}

export interface PartyTaxRegistration {
  id: string;
  regime: TaxRegime;
  number: string;
  region: string | null;
  countryCode: string;
  isPrimary: boolean;
  validFrom: string | null;
  validTo: string | null;
}

export interface PartyPage {
  items: PartySummary[];
  page: number;
  pageSize: number;
  total: number;
}

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

/**
 * The party master — customers and vendors in one table.
 *
 * AR and AP both consume this service; nothing here knows which one is calling.
 * `role` says what a party may be used for and is widened rather than
 * duplicated, so billing a company you also buy from does not create a second
 * identity.
 *
 * The `external_refs` pointer is the interesting part. CRM owns the company
 * record; accounting owns the party. `resolveOrCreateByExternalRef` is the only
 * bridge, and it is idempotent, which is what makes "a CRM company maps to
 * exactly one customer" true rather than aspirational (PRD 07 acceptance 5).
 */
@Injectable()
export class PartiesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly books: BooksService,
  ) {}

  /* ----------------------------------------------------------------- read */

  async list(orgId: string, query: ListPartiesQuery = {}): Promise<PartyPage> {
    const book = await this.books.requireDefault(orgId);
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const filters = [
      eq(glParties.orgId, orgId),
      eq(glParties.bookId, book.id),
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
      this.db
        .select(SUMMARY_COLUMNS)
        .from(glParties)
        .where(where)
        .orderBy(asc(glParties.displayName), asc(glParties.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db.select({ total: sql<string>`count(*)` }).from(glParties).where(where),
    ]);

    return { items, page, pageSize, total: Number(counted?.total ?? 0) };
  }

  /** Cross-tenant ids resolve to 404, never 403 (backend/CLAUDE.md §4). */
  async get(orgId: string, partyId: string, tx: DbOrTx = this.db): Promise<PartyDetail> {
    const [row] = await tx
      .select(DETAIL_COLUMNS)
      .from(glParties)
      .where(
        and(eq(glParties.orgId, orgId), eq(glParties.id, partyId), isNull(glParties.deletedAt)),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Party not found");

    return { ...row, taxRegistrations: await this.listRegistrations(orgId, partyId, tx) };
  }

  /**
   * The lookup AR and AP use before putting a party on a document — same 404
   * semantics, but it also proves the party belongs to the book being posted to.
   */
  async requireForBook(
    orgId: string,
    bookId: string,
    partyId: string,
    tx: DbOrTx = this.db,
  ): Promise<PartyDetail> {
    const party = await this.get(orgId, partyId, tx);
    if (party.bookId !== bookId) throw new NotFoundException("Party not found");
    return party;
  }

  /* ---------------------------------------------------------------- write */

  async create(orgId: string, userId: string | null, input: CreatePartyInput): Promise<PartyDetail> {
    const book = await this.books.requireDefault(orgId);
    return this.createInBook(orgId, book.id, userId, input);
  }

  private async createInBook(
    orgId: string,
    bookId: string,
    userId: string | null,
    input: CreatePartyInput,
    tx: DbOrTx = this.db,
  ): Promise<PartyDetail> {
    const [created] = await tx
      .insert(glParties)
      .values({
        orgId,
        bookId,
        role: input.role ?? "customer",
        displayName: input.displayName,
        legalName: input.legalName ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        countryCode: input.countryCode.toUpperCase(),
        defaultCurrency: input.defaultCurrency.toUpperCase(),
        billingLine1: input.billingLine1 ?? null,
        billingLine2: input.billingLine2 ?? null,
        billingCity: input.billingCity ?? null,
        billingRegion: input.billingRegion ?? null,
        billingPostalCode: input.billingPostalCode ?? null,
        billingCountryCode: input.billingCountryCode ?? input.countryCode.toUpperCase(),
        shippingLine1: input.shippingLine1 ?? null,
        shippingCity: input.shippingCity ?? null,
        shippingRegion: input.shippingRegion ?? null,
        shippingPostalCode: input.shippingPostalCode ?? null,
        shippingCountryCode: input.shippingCountryCode ?? null,
        externalRefs: input.externalRefs ?? [],
        defaultIncomeAccountId: input.defaultIncomeAccountId ?? null,
        defaultExpenseAccountId: input.defaultExpenseAccountId ?? null,
        paymentTermsDays: input.paymentTermsDays ?? 30,
        withholdingCode: input.withholdingCode ?? null,
        notes: input.notes ?? null,
        isActive: input.isActive ?? true,
        createdBy: userId,
      })
      .returning({ id: glParties.id });

    if (!created) throw new ConflictException("Could not create the party");
    return this.get(orgId, created.id, tx);
  }

  async update(orgId: string, partyId: string, patch: UpdatePartyInput): Promise<PartyDetail> {
    await this.get(orgId, partyId);

    const values: Partial<typeof glParties.$inferInsert> = {};
    const assign = <K extends keyof typeof glParties.$inferInsert>(
      key: K,
      value: (typeof glParties.$inferInsert)[K] | undefined,
    ) => {
      if (value !== undefined) values[key] = value;
    };

    assign("role", patch.role);
    assign("displayName", patch.displayName);
    assign("legalName", patch.legalName ?? undefined);
    assign("email", patch.email ?? undefined);
    assign("phone", patch.phone ?? undefined);
    assign("countryCode", patch.countryCode?.toUpperCase());
    assign("defaultCurrency", patch.defaultCurrency?.toUpperCase());
    assign("billingLine1", patch.billingLine1 ?? undefined);
    assign("billingLine2", patch.billingLine2 ?? undefined);
    assign("billingCity", patch.billingCity ?? undefined);
    assign("billingRegion", patch.billingRegion ?? undefined);
    assign("billingPostalCode", patch.billingPostalCode ?? undefined);
    assign("billingCountryCode", patch.billingCountryCode ?? undefined);
    assign("shippingLine1", patch.shippingLine1 ?? undefined);
    assign("shippingCity", patch.shippingCity ?? undefined);
    assign("shippingRegion", patch.shippingRegion ?? undefined);
    assign("shippingPostalCode", patch.shippingPostalCode ?? undefined);
    assign("shippingCountryCode", patch.shippingCountryCode ?? undefined);
    assign("defaultIncomeAccountId", patch.defaultIncomeAccountId ?? undefined);
    assign("defaultExpenseAccountId", patch.defaultExpenseAccountId ?? undefined);
    assign("paymentTermsDays", patch.paymentTermsDays);
    assign("withholdingCode", patch.withholdingCode ?? undefined);
    assign("notes", patch.notes ?? undefined);
    assign("isActive", patch.isActive);
    assign("externalRefs", patch.externalRefs);

    if (Object.keys(values).length > 0) {
      await this.db
        .update(glParties)
        .set(values)
        .where(and(eq(glParties.orgId, orgId), eq(glParties.id, partyId)));
    }

    return this.get(orgId, partyId);
  }

  /** Soft delete — a party on a posted document must stay resolvable forever. */
  async remove(orgId: string, partyId: string): Promise<{ id: string; deleted: true }> {
    await this.get(orgId, partyId);
    await this.db
      .update(glParties)
      .set({ deletedAt: new Date(), isActive: false })
      .where(and(eq(glParties.orgId, orgId), eq(glParties.id, partyId)));
    return { id: partyId, deleted: true };
  }

  /* ------------------------------------------------------- external refs */

  /**
   * Find the party this external record already maps to, or create it.
   *
   * Two callers racing on the same CRM company would both miss the lookup and
   * both insert, so the read and the write are serialised on a transaction-scoped
   * advisory lock keyed by `(book, system, id)`. The lock is released at commit;
   * nothing outside this transaction ever waits on it.
   */
  async resolveOrCreateByExternalRef(
    orgId: string,
    bookId: string,
    ref: ExternalRef,
    fields: CreatePartyInput,
    userId: string | null = null,
    tx?: DbOrTx,
  ): Promise<PartyDetail> {
    const run = async (t: DbOrTx): Promise<PartyDetail> => {
      const lockKey = `gl_parties:${bookId}:${ref.system}:${ref.id}`;
      await t.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}), 0)`);

      const existing = await this.findByExternalRef(orgId, bookId, ref, t);
      if (existing) return this.widenRole(orgId, existing, fields.role, t);

      const created = await this.createInBook(
        orgId,
        bookId,
        userId,
        {
          ...fields,
          externalRefs: this.mergeRefs(fields.externalRefs ?? [], ref),
        },
        t,
      );
      return created;
    };

    return tx ? run(tx) : this.db.transaction((t) => run(t));
  }

  async findByExternalRef(
    orgId: string,
    bookId: string,
    ref: ExternalRef,
    tx: DbOrTx = this.db,
  ): Promise<PartyDetail | null> {
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

    return row ? this.get(orgId, row.id, tx) : null;
  }

  /** Attach a pointer to an existing party without disturbing the others. */
  async linkExternalRef(orgId: string, partyId: string, ref: ExternalRef): Promise<PartyDetail> {
    const party = await this.get(orgId, partyId);
    const merged = this.mergeRefs(party.externalRefs, ref);
    if (merged.length !== party.externalRefs.length) {
      await this.db
        .update(glParties)
        .set({ externalRefs: merged })
        .where(and(eq(glParties.orgId, orgId), eq(glParties.id, partyId)));
    }
    return this.get(orgId, partyId);
  }

  private mergeRefs(refs: readonly ExternalRef[], ref: ExternalRef): ExternalRef[] {
    return refs.some((r) => r.system === ref.system && r.id === ref.id)
      ? [...refs]
      : [...refs, { system: ref.system, id: ref.id }];
  }

  /**
   * A vendor the sales team just invoiced is not a second company — it is the
   * same party in both roles. Widening never narrows.
   */
  private async widenRole(
    orgId: string,
    party: PartyDetail,
    wanted: CreatePartyInput["role"],
    tx: DbOrTx,
  ): Promise<PartyDetail> {
    if (!wanted || wanted === party.role || party.role === "both") return party;
    await tx
      .update(glParties)
      .set({ role: "both" })
      .where(and(eq(glParties.orgId, orgId), eq(glParties.id, party.id)));
    return this.get(orgId, party.id, tx);
  }

  /* --------------------------------------------------- tax registrations */

  async listRegistrations(
    orgId: string,
    partyId: string,
    tx: DbOrTx = this.db,
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

  /**
   * Registrations hang off the party, not off the document, so a customer's
   * GSTIN is entered once and every future invoice determines against it.
   */
  async addRegistration(
    orgId: string,
    partyId: string,
    input: CreateTaxRegistrationInput,
  ): Promise<PartyTaxRegistration> {
    await this.get(orgId, partyId);
    if (input.validFrom && input.validTo && input.validTo < input.validFrom) {
      throw new BadRequestException("validTo cannot be earlier than validFrom");
    }

    const number = input.number.trim().toUpperCase();
    const existing = await this.listRegistrations(orgId, partyId);
    if (existing.some((r) => r.regime === input.regime && r.number === number)) {
      throw new ConflictException(`${input.regime} ${number} is already recorded for this party`);
    }

    const [created] = await this.db
      .insert(taxRegistrations)
      .values({
        orgId,
        ownerType: "party",
        bookId: null,
        partyId,
        regime: input.regime,
        number,
        // India reads the state from the first two digits of a GSTIN; anywhere
        // else the caller supplies it. Either way the engine gets a region.
        region: input.region ?? this.regionFromNumber(input.regime, number),
        countryCode: input.countryCode.toUpperCase(),
        isPrimary: input.isPrimary ?? existing.length === 0,
        validFrom: input.validFrom ?? null,
        validTo: input.validTo ?? null,
      })
      .returning({ id: taxRegistrations.id });

    if (!created) throw new ConflictException("Could not record the tax registration");
    const saved = (await this.listRegistrations(orgId, partyId)).find((r) => r.id === created.id);
    if (!saved) throw new ConflictException("Could not record the tax registration");
    return saved;
  }

  async removeRegistration(
    orgId: string,
    partyId: string,
    registrationId: string,
  ): Promise<{ id: string; deleted: true }> {
    await this.get(orgId, partyId);
    const deleted = await this.db
      .delete(taxRegistrations)
      .where(
        and(
          eq(taxRegistrations.orgId, orgId),
          eq(taxRegistrations.id, registrationId),
          eq(taxRegistrations.ownerType, "party"),
          eq(taxRegistrations.partyId, partyId),
        ),
      )
      .returning({ id: taxRegistrations.id });

    if (deleted.length === 0) throw new NotFoundException("Tax registration not found");
    return { id: registrationId, deleted: true };
  }

  private regionFromNumber(regime: TaxRegime, number: string): string | null {
    if (regime !== "GST_IN") return null;
    return /^\d{2}/.test(number) ? number.slice(0, 2) : null;
  }
}
