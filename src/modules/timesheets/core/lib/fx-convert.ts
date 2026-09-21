export interface CurrencyAmount {
  currency: string;
  amount: number;
}

export interface FxRate {
  rate: number;
  asOfDate: string;
}

export interface FxConversion {
  currency: string;
  amount: number;
  rate: number;
  rateDate: string | null;
  converted: number;
}

export interface ConvertedTotals {
  baseCurrency: string;
  convertedTotal: number;
  conversions: FxConversion[];
  missingRates: string[];
}

function to2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function convertAmounts(
  byCurrency: CurrencyAmount[],
  baseCurrency: string,
  rates: Map<string, FxRate>,
): ConvertedTotals {
  const conversions: FxConversion[] = [];
  const missingRates: string[] = [];
  let convertedTotal = 0;

  for (const { currency, amount } of byCurrency) {
    if (currency === baseCurrency) {
      const converted = to2(amount);
      conversions.push({ currency, amount, rate: 1, rateDate: null, converted });
      convertedTotal = to2(convertedTotal + converted);
      continue;
    }

    const rate = rates.get(currency);
    if (!rate) {
      missingRates.push(currency);
      continue;
    }

    const converted = to2(amount * rate.rate);
    conversions.push({ currency, amount, rate: rate.rate, rateDate: rate.asOfDate, converted });
    convertedTotal = to2(convertedTotal + converted);
  }

  return { baseCurrency, convertedTotal, conversions, missingRates };
}
