import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, lte } from "drizzle-orm";
import { glBookCurrencies, glBooks, glCurrencies, glFxRates } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { assertCurrencyCode, convert, minorUnitsOf, money, toDecimalString } from "./money";
import type { DbOrTx } from "./sequence.service";

/**
 * Manual FX rates (PRD 11).
 *
 * There is no live feed in v1 and that is deliberate — a wrong automatic rate
 * is worse than an absent one, because it posts silently. A missing rate is an
 * error the document layer must surface, never a quiet fallback to 1.
 *
 * Direction is fixed: `rate` multiplies **transaction currency into functional
 * currency**.
 */
@Injectable()
export class FxService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async listCurrencies() {
    return this.db
      .select({
        code: glCurrencies.code,
        name: glCurrencies.name,
        minorUnits: glCurrencies.minorUnits,
        symbol: glCurrencies.symbol,
      })
      .from(glCurrencies)
      .where(eq(glCurrencies.isActive, true))
      .orderBy(glCurrencies.code);
  }

  async listBookCurrencies(orgId: string, bookId: string) {
    return this.db
      .select({
        currencyCode: glBookCurrencies.currencyCode,
        isBase: glBookCurrencies.isBase,
        minorUnits: glCurrencies.minorUnits,
        name: glCurrencies.name,
        symbol: glCurrencies.symbol,
      })
      .from(glBookCurrencies)
      .innerJoin(glCurrencies, eq(glBookCurrencies.currencyCode, glCurrencies.code))
      .where(and(eq(glBookCurrencies.orgId, orgId), eq(glBookCurrencies.bookId, bookId)));
  }

  /** Allow a book to transact in another currency. The base is never changed. */
  async enableCurrency(orgId: string, userId: string, bookId: string, currencyCode: string) {
    const code = assertCurrencyCode(currencyCode.toUpperCase());
    const [currency] = await this.db
      .select({ code: glCurrencies.code })
      .from(glCurrencies)
      .where(eq(glCurrencies.code, code))
      .limit(1);
    if (!currency) throw new NotFoundException(`${code} is not a known currency`);

    await this.db
      .insert(glBookCurrencies)
      .values({ orgId, bookId, currencyCode: code, isBase: false })
      .onConflictDoNothing();

    this.audit.log({
      action: "accounting.currency.enabled",
      userId,
      orgId,
      resourceType: "gl_book_currencies",
      resourceId: `${bookId}:${code}`,
      after: { currencyCode: code },
    });
    return { currencyCode: code };
  }

  async listRates(orgId: string, bookId: string, filters: { from?: string; to?: string } = {}) {
    return this.db
      .select({
        id: glFxRates.id,
        fromCode: glFxRates.fromCode,
        toCode: glFxRates.toCode,
        rateDate: glFxRates.rateDate,
        rate: glFxRates.rate,
        source: glFxRates.source,
        capturedAt: glFxRates.capturedAt,
      })
      .from(glFxRates)
      .where(
        and(
          eq(glFxRates.orgId, orgId),
          eq(glFxRates.bookId, bookId),
          filters.from ? eq(glFxRates.fromCode, filters.from.toUpperCase()) : undefined,
          filters.to ? eq(glFxRates.toCode, filters.to.toUpperCase()) : undefined,
        ),
      )
      .orderBy(desc(glFxRates.rateDate))
      .limit(100);
  }

  async upsertRate(
    orgId: string,
    userId: string,
    bookId: string,
    input: { fromCode: string; toCode: string; rateDate: string; rate: string; source?: string },
  ) {
    const fromCode = assertCurrencyCode(input.fromCode.toUpperCase());
    const toCode = assertCurrencyCode(input.toCode.toUpperCase());
    if (fromCode === toCode) {
      throw new BadRequestException("A currency's rate against itself is always 1");
    }
    if (!/^\d+(\.\d{1,10})?$/.test(input.rate) || Number(input.rate) <= 0) {
      throw new BadRequestException(
        "Rate must be a positive decimal with at most 10 decimal places",
      );
    }

    const [row] = await this.db
      .insert(glFxRates)
      .values({
        orgId,
        bookId,
        fromCode,
        toCode,
        rateDate: input.rateDate,
        rate: input.rate,
        source: input.source ?? "manual",
        createdBy: userId,
      })
      .onConflictDoUpdate({
        target: [glFxRates.bookId, glFxRates.fromCode, glFxRates.toCode, glFxRates.rateDate],
        set: { rate: input.rate, source: input.source ?? "manual", capturedAt: new Date() },
      })
      .returning();

    this.audit.log({
      action: "accounting.fx_rate.set",
      userId,
      orgId,
      resourceType: "gl_fx_rates",
      resourceId: row.id,
      after: { fromCode, toCode, rateDate: input.rateDate, rate: input.rate },
    });
    return row;
  }

  /**
   * The rate to use for a document: the most recent one on or before its date.
   *
   * Returns null rather than guessing. Callers must treat that as an error the
   * user has to resolve — PRD 11's "missing rate: error, do not silently use 1".
   */
  async rateFor(
    bookId: string,
    fromCode: string,
    toCode: string,
    onDate: string,
    tx: DbOrTx = this.db,
  ): Promise<{ id: string; rate: string; rateDate: string } | null> {
    if (fromCode === toCode) return { id: "", rate: "1", rateDate: onDate };

    const [row] = await tx
      .select({ id: glFxRates.id, rate: glFxRates.rate, rateDate: glFxRates.rateDate })
      .from(glFxRates)
      .where(
        and(
          eq(glFxRates.bookId, bookId),
          eq(glFxRates.fromCode, fromCode),
          eq(glFxRates.toCode, toCode),
          lte(glFxRates.rateDate, onDate),
        ),
      )
      .orderBy(desc(glFxRates.rateDate))
      .limit(1);
    return row ?? null;
  }

  /** Same as `rateFor` but throws the message a founder should actually see. */
  async requireRateFor(
    bookId: string,
    fromCode: string,
    toCode: string,
    onDate: string,
    tx: DbOrTx = this.db,
  ): Promise<{ id: string; rate: string; rateDate: string }> {
    const rate = await this.rateFor(bookId, fromCode, toCode, onDate, tx);
    if (!rate) {
      throw new BadRequestException(
        `No exchange rate for ${fromCode} to ${toCode} on or before ${onDate}. Add one before posting.`,
      );
    }
    return rate;
  }

  /** Preview a conversion without posting anything. */
  async preview(
    orgId: string,
    bookId: string,
    input: { amountMinor: number; fromCode: string; toCode: string; onDate: string },
  ) {
    const [book] = await this.db
      .select({ baseCurrency: glBooks.baseCurrency })
      .from(glBooks)
      .where(and(eq(glBooks.orgId, orgId), eq(glBooks.id, bookId)))
      .limit(1);
    if (!book) throw new NotFoundException("Book not found");

    const fromCode = assertCurrencyCode(input.fromCode.toUpperCase());
    const toCode = assertCurrencyCode(input.toCode.toUpperCase());
    const rate = await this.requireRateFor(bookId, fromCode, toCode, input.onDate);
    const source = money(input.amountMinor, fromCode);
    const converted = convert(source, toCode, rate.rate);

    return {
      from: {
        currency: fromCode,
        amountMinor: source.minor,
        display: toDecimalString(source),
        minorUnits: minorUnitsOf(fromCode),
      },
      to: {
        currency: toCode,
        amountMinor: converted.minor,
        display: toDecimalString(converted),
        minorUnits: minorUnitsOf(toCode),
      },
      rate: rate.rate,
      rateDate: rate.rateDate,
      rateId: rate.id || null,
    };
  }
}
