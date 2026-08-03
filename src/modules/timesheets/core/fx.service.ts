import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { finExchangeRates } from "../../../db/schema";

@Injectable()
export class FxService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * Latest known rate per from-currency for (org, from, toCurrency),
   * i.e. the row with the max asOfDate for each pair.
   */
  async getLatestRates(
    orgId: string,
    fromCurrencies: string[],
    toCurrency: string,
  ): Promise<Map<string, { rate: number; asOfDate: string }>> {
    if (fromCurrencies.length === 0) return new Map();

    const rows = await this.db
      .selectDistinctOn([finExchangeRates.fromCurrency], {
        fromCurrency: finExchangeRates.fromCurrency,
        rate: finExchangeRates.rate,
        asOfDate: finExchangeRates.asOfDate,
      })
      .from(finExchangeRates)
      .where(
        and(
          eq(finExchangeRates.orgId, orgId),
          inArray(finExchangeRates.fromCurrency, fromCurrencies),
          eq(finExchangeRates.toCurrency, toCurrency),
        ),
      )
      .orderBy(finExchangeRates.fromCurrency, desc(finExchangeRates.asOfDate));

    return new Map(
      rows.map((r) => [r.fromCurrency, { rate: parseFloat(r.rate), asOfDate: r.asOfDate }]),
    );
  }
}
