import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, lte, desc } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { finExchangeRates } from "../../../db/schema";

@Injectable()
export class RateResolverService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * The rate as a decimal string, exactly as `fin_exchange_rates.rate`
   * (`numeric(18,8)`) holds it — units of `to` per one unit of `from`.
   *
   * Journal amounts are decimal strings multiplied through
   * `accounting/core/money.util`, so the rate has to stay text to reach them
   * without a round trip through an IEEE-754 double. `getRate` below is the
   * lossy convenience wrapper kept for callers that still work in numbers.
   */
  async getRateString(orgId: string, from: string, to: string, onDate: Date): Promise<string> {
    if (from === to) return "1";

    const isoDate = onDate.toISOString().slice(0, 10);

    const exactRow = await this.db
      .select({ rate: finExchangeRates.rate })
      .from(finExchangeRates)
      .where(
        and(
          eq(finExchangeRates.orgId, orgId),
          eq(finExchangeRates.fromCurrency, from),
          eq(finExchangeRates.toCurrency, to),
          eq(finExchangeRates.asOfDate, isoDate),
        ),
      )
      .limit(1);

    if (exactRow[0]) return exactRow[0].rate;

    const latestRow = await this.db
      .select({ rate: finExchangeRates.rate })
      .from(finExchangeRates)
      .where(
        and(
          eq(finExchangeRates.orgId, orgId),
          eq(finExchangeRates.fromCurrency, from),
          eq(finExchangeRates.toCurrency, to),
          lte(finExchangeRates.asOfDate, isoDate),
        ),
      )
      .orderBy(desc(finExchangeRates.asOfDate))
      .limit(1);

    if (latestRow[0]) return latestRow[0].rate;

    throw new NotFoundException(
      `No exchange rate found for ${from} → ${to} on or before ${isoDate}`,
    );
  }

  async getRate(orgId: string, from: string, to: string, onDate: Date): Promise<number> {
    return Number(await this.getRateString(orgId, from, to, onDate));
  }
}
