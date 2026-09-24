import { Injectable } from "@nestjs/common";
import { BooksService } from "../../accounting/kernel/books.service";
import { FxService as AccountingFxService } from "../../accounting/kernel/fx.service";

@Injectable()
export class FxService {
  constructor(
    private readonly books: BooksService,
    private readonly fx: AccountingFxService,
  ) {}

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
