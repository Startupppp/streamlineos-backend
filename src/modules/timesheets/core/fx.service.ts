import { Injectable } from "@nestjs/common";
import { BooksService } from "../../accounting/kernel/books.service";
import { FxService as AccountingFxService } from "../../accounting/kernel/fx.service";

/**
 * Exchange rates for billing evidence, read through accounting.
 *
 * Timesheets does not keep its own rate table and does not touch accounting's:
 * rates live on the org's book (`gl_fx_rates`) and are read through the kernel
 * so a rate a founder entered once is the same number both modules quote.
 *
 * Accounting is opt-in, so an org that never enabled it has no book and
 * therefore no rates. That is answered with an empty map, not an exception —
 * `convertAmounts` already reports unconvertible currencies as `missingRates`,
 * which is the honest answer and the one the UI is built for.
 */
@Injectable()
export class FxService {
  constructor(
    private readonly books: BooksService,
    private readonly fx: AccountingFxService,
  ) {}

  /**
   * The rate in force today for each from-currency against `toCurrency`,
   * i.e. the most recent rate dated on or before today. Currencies with no
   * rate are simply absent from the map — never defaulted to 1.
   */
  async getLatestRates(
    orgId: string,
    fromCurrencies: string[],
    toCurrency: string,
  ): Promise<Map<string, { rate: number; asOfDate: string }>> {
    const result = new Map<string, { rate: number; asOfDate: string }>();
    if (fromCurrencies.length === 0) return result;

    const book = await this.books.findDefault(orgId);
    if (!book) return result;

    const onDate = new Date().toISOString().slice(0, 10);
    const wanted = [...new Set(fromCurrencies)];

    const rates = await Promise.all(
      wanted.map(async (from) => ({
        from,
        rate: await this.fx.rateFor(book.id, from, toCurrency, onDate),
      })),
    );

    for (const { from, rate } of rates) {
      if (!rate) continue;
      const numeric = parseFloat(rate.rate);
      if (!Number.isFinite(numeric) || numeric <= 0) continue;
      result.set(from, { rate: numeric, asOfDate: rate.rateDate });
    }
    return result;
  }
}
