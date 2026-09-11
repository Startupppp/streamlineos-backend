import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  glAccounts,
  glBookCurrencies,
  glBooks,
  glFiscalYears,
  glPeriods,
  type GlSystemTag,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { PackRegistry } from "../packs/pack.registry";
import type { CoaTemplateAccount, LocalizationPack } from "../packs/pack.types";
import { fiscalYearFor, monthlyPeriodsFor } from "./fiscal-calendar";
import { assertCurrencyCode } from "./money";
import type { DbOrTx } from "./sequence.service";

export interface EnableAccountingInput {
  /** Defaults to the org's country when the caller does not say. */
  countryCode: string;
  /** Overrides the pack default, for a book that reports in another currency. */
  baseCurrency?: string;
  /** Overrides the country lookup — an Indian org keeping USD books, say. */
  packCode?: string;
  name?: string;
  legalEntityId?: string;
  /** Anchors which fiscal year is opened. Defaults to today. */
  openFrom?: string;
}

export interface BookSummary {
  id: string;
  name: string;
  countryCode: string;
  baseCurrency: string;
  localizationPack: string;
  fiscalYearStartMonth: number;
  fiscalYearStartDay: number;
  timezone: string;
  isDefault: boolean;
  status: "ACTIVE" | "ARCHIVED";
}

/**
 * Provisioning and lookup for books.
 *
 * Enabling accounting is **idempotent**: running it twice returns the same book
 * with the same chart, because a founder who double-clicks Enable should not end
 * up with two "1000 Cash" accounts (PRD 12 acceptance 4).
 */
@Injectable()
export class BooksService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly packs: PackRegistry,
  ) {}

  /** Enable accounting for an org, or return the book that already exists. */
  async enable(
    orgId: string,
    userId: string | null,
    input: EnableAccountingInput,
  ): Promise<BookSummary> {
    return this.db.transaction(async (tx) => {
      const existing = await this.findDefault(orgId, tx);
      if (existing) {
        // Already enabled. Re-seed anyway so a pack that gained an account in a
        // later release picks it up, then hand back the same book.
        await this.seedChartOfAccounts(orgId, existing.id, this.packs.get(existing.localizationPack), tx);
        await this.ensureFiscalYear(orgId, existing.id, input.openFrom ?? this.today(), tx);
        return existing;
      }

      const pack = input.packCode
        ? this.packs.get(input.packCode)
        : this.packs.forCountry(input.countryCode);

      const baseCurrency = assertCurrencyCode(input.baseCurrency ?? pack.defaultCurrency);

      const [book] = await tx
        .insert(glBooks)
        .values({
          orgId,
          legalEntityId: input.legalEntityId ?? null,
          name: input.name ?? "Primary book",
          countryCode: input.countryCode.toUpperCase(),
          baseCurrency,
          localizationPack: pack.code,
          fiscalYearStartMonth: pack.fiscalYearStart.month,
          fiscalYearStartDay: pack.fiscalYearStart.day,
          timezone: pack.defaultTimezone,
          isDefault: true,
          createdBy: userId,
        })
        .returning();

      if (!book) throw new ConflictException("Could not create the accounting book");

      await tx
        .insert(glBookCurrencies)
        .values({ orgId, bookId: book.id, currencyCode: baseCurrency, isBase: true })
        .onConflictDoNothing();

      await this.seedChartOfAccounts(orgId, book.id, pack, tx);
      await this.ensureFiscalYear(orgId, book.id, input.openFrom ?? this.today(), tx);

      return this.toSummary(book);
    });
  }

  async findDefault(orgId: string, tx: DbOrTx = this.db): Promise<BookSummary | null> {
    const [book] = await tx
      .select()
      .from(glBooks)
      .where(and(eq(glBooks.orgId, orgId), eq(glBooks.isDefault, true), isNull(glBooks.deletedAt)))
      .limit(1);
    return book ? this.toSummary(book) : null;
  }

  /** The book every request works against until multi-entity ships. */
  async requireDefault(orgId: string, tx: DbOrTx = this.db): Promise<BookSummary> {
    const book = await this.findDefault(orgId, tx);
    if (!book) {
      throw new NotFoundException("Accounting is not enabled for this organization");
    }
    return book;
  }

  async get(orgId: string, bookId: string, tx: DbOrTx = this.db): Promise<BookSummary> {
    const [book] = await tx
      .select()
      .from(glBooks)
      .where(and(eq(glBooks.orgId, orgId), eq(glBooks.id, bookId), isNull(glBooks.deletedAt)))
      .limit(1);
    // Cross-tenant ids resolve to 404, never 403 — a 403 would confirm the row
    // exists and turn a probe into an existence oracle (backend CLAUDE.md §4).
    if (!book) throw new NotFoundException("Book not found");
    return this.toSummary(book);
  }

  async list(orgId: string, tx: DbOrTx = this.db): Promise<BookSummary[]> {
    const rows = await tx
      .select()
      .from(glBooks)
      .where(and(eq(glBooks.orgId, orgId), isNull(glBooks.deletedAt)))
      .orderBy(asc(glBooks.createdAt));
    return rows.map((r) => this.toSummary(r));
  }

  /* ------------------------------------------------------------ seeding */

  /**
   * Insert the pack's chart. Headers go in first so children can point at a
   * parent that already exists; `onConflictDoNothing` on `(book_id, code)` is
   * what makes a re-run a no-op rather than a duplicate.
   */
  private async seedChartOfAccounts(
    orgId: string,
    bookId: string,
    pack: LocalizationPack,
    tx: DbOrTx,
  ): Promise<void> {
    const template = pack.chartOfAccounts;
    const headers = template.filter((a) => a.isHeader);
    const children = template.filter((a) => !a.isHeader);

    await this.insertAccounts(orgId, bookId, headers, new Map(), tx);

    const codeToId = await this.accountIdsByCode(bookId, tx);
    await this.insertAccounts(orgId, bookId, children, codeToId, tx);
  }

  private async insertAccounts(
    orgId: string,
    bookId: string,
    accounts: readonly CoaTemplateAccount[],
    codeToId: Map<string, string>,
    tx: DbOrTx,
  ): Promise<void> {
    if (accounts.length === 0) return;
    await tx
      .insert(glAccounts)
      .values(
        accounts.map((a) => ({
          orgId,
          bookId,
          code: a.code,
          name: a.name,
          accountType: a.type,
          parentAccountId: a.parentCode ? (codeToId.get(a.parentCode) ?? null) : null,
          isHeader: a.isHeader ?? false,
          isCash: a.isCash ?? false,
          systemTag: a.systemTag ?? null,
          description: a.description ?? null,
        })),
      )
      .onConflictDoNothing();
  }

  private async accountIdsByCode(bookId: string, tx: DbOrTx): Promise<Map<string, string>> {
    const rows = await tx
      .select({ id: glAccounts.id, code: glAccounts.code })
      .from(glAccounts)
      .where(and(eq(glAccounts.bookId, bookId), isNull(glAccounts.deletedAt)));
    return new Map(rows.map((r) => [r.code, r.id]));
  }

  /**
   * Resolve an account by the role a pack tagged it with, so no document ever
   * hardcodes "1100" (PRD 01 S3). A missing tag is a setup error worth naming
   * loudly — booking to the wrong account silently is far worse.
   */
  async resolveAccountByTag(
    bookId: string,
    tag: GlSystemTag,
    tx: DbOrTx = this.db,
  ): Promise<string> {
    const [row] = await tx
      .select({ id: glAccounts.id })
      .from(glAccounts)
      .where(
        and(
          eq(glAccounts.bookId, bookId),
          eq(glAccounts.systemTag, tag),
          eq(glAccounts.isActive, true),
          isNull(glAccounts.deletedAt),
        ),
      )
      .limit(1);

    if (!row) {
      throw new NotFoundException(
        `No account is tagged "${tag}" in this book. Re-run the chart of accounts setup.`,
      );
    }
    return row.id;
  }

  /** Batch form of `resolveAccountByTag`, one query for a whole posting map. */
  async resolveAccountsByTag(
    bookId: string,
    tags: readonly GlSystemTag[],
    tx: DbOrTx = this.db,
  ): Promise<Map<GlSystemTag, string>> {
    if (tags.length === 0) return new Map();
    const rows = await tx
      .select({ id: glAccounts.id, systemTag: glAccounts.systemTag })
      .from(glAccounts)
      .where(
        and(
          eq(glAccounts.bookId, bookId),
          eq(glAccounts.isActive, true),
          isNull(glAccounts.deletedAt),
        ),
      );

    const found = new Map<GlSystemTag, string>();
    for (const row of rows) {
      if (row.systemTag) found.set(row.systemTag, row.id);
    }

    const missing = tags.filter((t) => !found.has(t));
    if (missing.length > 0) {
      throw new NotFoundException(
        `No account is tagged ${missing.map((m) => `"${m}"`).join(", ")} in this book. ` +
          "Re-run the chart of accounts setup.",
      );
    }
    return found;
  }

  /* ------------------------------------------------- fiscal year opening */

  /**
   * Open the fiscal year containing `onDate` along with its twelve periods.
   * Safe to call repeatedly — the unique on `(book_id, starts_on)` makes a
   * second call a no-op.
   */
  async ensureFiscalYear(
    orgId: string,
    bookId: string,
    onDate: string,
    tx: DbOrTx = this.db,
  ): Promise<{ id: string; name: string; startsOn: string; endsOn: string }> {
    const [book] = await tx
      .select({
        fiscalYearStartMonth: glBooks.fiscalYearStartMonth,
        fiscalYearStartDay: glBooks.fiscalYearStartDay,
        localizationPack: glBooks.localizationPack,
      })
      .from(glBooks)
      .where(and(eq(glBooks.orgId, orgId), eq(glBooks.id, bookId)))
      .limit(1);
    if (!book) throw new NotFoundException("Book not found");

    const pack = this.packs.get(book.localizationPack);
    const span = fiscalYearFor(
      onDate,
      book.fiscalYearStartMonth,
      book.fiscalYearStartDay,
      pack.fiscalYearNaming,
    );

    const [existing] = await tx
      .select({ id: glFiscalYears.id, name: glFiscalYears.name, startsOn: glFiscalYears.startsOn, endsOn: glFiscalYears.endsOn })
      .from(glFiscalYears)
      .where(and(eq(glFiscalYears.bookId, bookId), eq(glFiscalYears.startsOn, span.startsOn)))
      .limit(1);
    if (existing) return existing;

    const [created] = await tx
      .insert(glFiscalYears)
      .values({ orgId, bookId, name: span.name, startsOn: span.startsOn, endsOn: span.endsOn })
      .onConflictDoNothing()
      .returning({ id: glFiscalYears.id, name: glFiscalYears.name, startsOn: glFiscalYears.startsOn, endsOn: glFiscalYears.endsOn });

    if (!created) {
      // Lost a race; the winner's row is the answer.
      const [winner] = await tx
        .select({ id: glFiscalYears.id, name: glFiscalYears.name, startsOn: glFiscalYears.startsOn, endsOn: glFiscalYears.endsOn })
        .from(glFiscalYears)
        .where(and(eq(glFiscalYears.bookId, bookId), eq(glFiscalYears.startsOn, span.startsOn)))
        .limit(1);
      if (!winner) throw new ConflictException("Could not open the fiscal year");
      return winner;
    }

    await tx
      .insert(glPeriods)
      .values(
        monthlyPeriodsFor(span).map((p) => ({
          orgId,
          bookId,
          fiscalYearId: created.id,
          name: p.name,
          startsOn: p.startsOn,
          endsOn: p.endsOn,
          sequence: p.sequence,
        })),
      )
      .onConflictDoNothing();

    return created;
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private toSummary(book: typeof glBooks.$inferSelect): BookSummary {
    return {
      id: book.id,
      name: book.name,
      countryCode: book.countryCode,
      baseCurrency: book.baseCurrency,
      localizationPack: book.localizationPack,
      fiscalYearStartMonth: book.fiscalYearStartMonth,
      fiscalYearStartDay: book.fiscalYearStartDay,
      timezone: book.timezone,
      isDefault: book.isDefault,
      status: book.status,
    };
  }
}
