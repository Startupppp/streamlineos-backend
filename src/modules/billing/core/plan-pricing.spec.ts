import { PLAN_PRICES_PAISE, ANNUAL_DISCOUNT_PCT } from "./plan-entitlements.constants";
import {
  FALLBACK_CURRENCY,
  SUPPORTED_CURRENCIES,
  annualPrice,
  isSupportedCurrency,
  priceFor,
  priceList,
  resolveCurrency,
} from "./plan-pricing";

describe("priceFor", () => {
  it("prices a plan in the currency asked for", () => {
    expect(priceFor("STARTER", "USD")).toEqual({
      plan: "STARTER",
      amountMinor: 1_900,
      currency: "USD",
      isRequestedCurrency: true,
    });
  });

  it("keeps the existing rupee prices exactly, so nothing an Indian tenant pays moves", () => {
    // The single most important assertion here: this ticket adds currencies, it
    // does not reprice the market that already pays us.
    for (const plan of ["STARTER", "PROFESSIONAL", "ENTERPRISE"] as const)
      expect(priceFor(plan, "INR").amountMinor).toBe(PLAN_PRICES_PAISE[plan]);
  });

  it("never converts — the columns are not one rate applied three times", () => {
    // If these were conversions, INR/USD would be the same ratio for every plan.
    // They are local prices, so the ratios differ, and this fails if somebody
    // later "tidies" the table into a rate.
    const ratios = (["STARTER", "PROFESSIONAL", "ENTERPRISE"] as const).map(
      (plan) => priceFor(plan, "INR").amountMinor / priceFor(plan, "USD").amountMinor,
    );

    expect(new Set(ratios.map((r) => r.toFixed(2))).size).toBeGreaterThan(1);
  });

  it("falls back to a stated currency, and says it fell back", () => {
    const price = priceFor("STARTER", "NOK");

    expect(price.currency).toBe(FALLBACK_CURRENCY);
    expect(price.isRequestedCurrency).toBe(false);
  });

  it("accepts a currency in any case or padding a form might send", () => {
    for (const raw of ["usd", " USD ", "Usd"]) {
      const price = priceFor("STARTER", raw);
      expect(price.currency).toBe("USD");
      expect(price.isRequestedCurrency).toBe(true);
    }
  });

  it("falls back rather than throwing for an absent currency", () => {
    // A pricing page renders before a prospect's country is known.
    for (const bad of [null, undefined, "", "   "])
      expect(priceFor("STARTER", bad).currency).toBe(FALLBACK_CURRENCY);
  });

  it("prices every plan in every supported currency", () => {
    // A currency added to the list without prices would fall through to
    // undefined and charge NaN.
    for (const currency of SUPPORTED_CURRENCIES)
      for (const plan of ["STARTER", "PROFESSIONAL", "ENTERPRISE"] as const) {
        const price = priceFor(plan, currency);
        expect(Number.isInteger(price.amountMinor)).toBe(true);
        expect(price.amountMinor).toBeGreaterThan(0);
      }
  });

  it("charges more for a larger plan in every currency", () => {
    for (const currency of SUPPORTED_CURRENCIES) {
      const [starter, professional, enterprise] = priceList(currency);
      expect(professional!.amountMinor).toBeGreaterThan(starter!.amountMinor);
      expect(enterprise!.amountMinor).toBeGreaterThan(professional!.amountMinor);
    }
  });
});

describe("resolveCurrency", () => {
  it("reports whether the answer is the question", () => {
    expect(resolveCurrency("GBP")).toEqual({ currency: "GBP", isRequestedCurrency: true });
    expect(resolveCurrency("BRL")).toEqual({
      currency: FALLBACK_CURRENCY,
      isRequestedCurrency: false,
    });
  });

  it("guards the type, so an unpriced currency cannot reach the table", () => {
    expect(isSupportedCurrency("INR")).toBe(true);
    expect(isSupportedCurrency("XYZ")).toBe(false);
    expect(isSupportedCurrency(null)).toBe(false);
  });
});

describe("annualPrice", () => {
  it("rounds once at the end, not twelve times", () => {
    // Rounding per month is how a yearly total stops reconciling against twelve
    // monthly ones for reasons nobody can reconstruct.
    const monthly = priceFor("PROFESSIONAL", "USD");
    const annual = annualPrice(monthly, ANNUAL_DISCOUNT_PCT);

    expect(annual.amountMinor).toBe(
      Math.round(monthly.amountMinor * 12 * (1 - ANNUAL_DISCOUNT_PCT)),
    );
  });

  it("stays an integer in minor units", () => {
    for (const currency of SUPPORTED_CURRENCIES) {
      const annual = annualPrice(priceFor("STARTER", currency), ANNUAL_DISCOUNT_PCT);
      expect(Number.isInteger(annual.amountMinor)).toBe(true);
    }
  });

  it("keeps the currency it was given", () => {
    const annual = annualPrice(priceFor("STARTER", "EUR"), ANNUAL_DISCOUNT_PCT);
    expect(annual.currency).toBe("EUR");
  });

  it("costs less than twelve months, or the discount is not one", () => {
    const monthly = priceFor("ENTERPRISE", "GBP");
    expect(annualPrice(monthly, ANNUAL_DISCOUNT_PCT).amountMinor).toBeLessThan(
      monthly.amountMinor * 12,
    );
  });
});
