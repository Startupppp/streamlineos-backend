/**
 * The two things a document needs from its book before it can be drafted or
 * numbered: the FX rate on its date, and the fiscal year covering that date.
 */
import { BadRequestException } from "@nestjs/common";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { glFiscalYears, glFxRates, glPeriods } from "../../../../db/schema";
import type { DbOrTx } from "../../kernel/sequence.service";

/**
 * The rate is snapshotted onto the document at draft time and never re-read,
 * so a rate published tomorrow cannot restate a posted invoice.
 */
export async function resolveFxRate(
  bookId: string,
  baseCurrency: string,
  currency: string,
  onDate: string,
  provided: string | undefined,
  tx: DbOrTx,
): Promise<string> {
  if (currency === baseCurrency) {
    if (provided && Number(provided) !== 1) {
      throw new BadRequestException(`A ${currency} document on ${baseCurrency} books needs rate 1`);
    }
    return "1";
  }
  if (provided) {
    if (!(Number(provided) > 0)) throw new BadRequestException("The FX rate must be positive");
    return provided;
  }

  const [row] = await tx
    .select({ rate: glFxRates.rate })
    .from(glFxRates)
    .where(
      and(
        eq(glFxRates.bookId, bookId),
        eq(glFxRates.fromCode, currency),
        eq(glFxRates.toCode, baseCurrency),
        lte(glFxRates.rateDate, onDate),
      ),
    )
    .orderBy(desc(glFxRates.rateDate))
    .limit(1);

  if (!row) {
    throw new BadRequestException(
      `No ${currency}/${baseCurrency} rate is on file for ${onDate}. Supply one with the document.`,
    );
  }
  return row.rate;
}

/**
 * The fiscal year covering the document date. Missing is a setup error, not
 * an invitation to invent a period — the kernel would reject the post anyway,
 * and this says so before a number is burned.
 */
export async function resolveFiscalYear(
  bookId: string,
  onDate: string,
  tx: DbOrTx,
): Promise<{ id: string; name: string }> {
  const [row] = await tx
    .select({ id: glFiscalYears.id, name: glFiscalYears.name })
    .from(glPeriods)
    .innerJoin(glFiscalYears, eq(glPeriods.fiscalYearId, glFiscalYears.id))
    .where(
      and(
        eq(glPeriods.bookId, bookId),
        lte(glPeriods.startsOn, onDate),
        gte(glPeriods.endsOn, onDate),
      ),
    )
    .limit(1);

  if (!row) {
    throw new BadRequestException(
      `No accounting period covers ${onDate}. Open the fiscal year first.`,
    );
  }
  return row;
}
