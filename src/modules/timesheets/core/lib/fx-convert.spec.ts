import { convertAmounts } from "./fx-convert";

describe("convertAmounts", () => {
  it("uses an identity rate of 1 for the base currency itself", () => {
    const result = convertAmounts([{ currency: "USD", amount: 100 }], "USD", new Map());

    expect(result).toEqual({
      baseCurrency: "USD",
      convertedTotal: 100,
      conversions: [{ currency: "USD", amount: 100, rate: 1, rateDate: null, converted: 100 }],
      missingRates: [],
    });
  });

  it("converts foreign currencies with the provided rates", () => {
    const rates = new Map([
      ["EUR", { rate: 1.1, asOfDate: "2026-07-01" }],
      ["INR", { rate: 0.012, asOfDate: "2026-07-15" }],
    ]);

    const result = convertAmounts(
      [
        { currency: "USD", amount: 50 },
        { currency: "EUR", amount: 200 },
        { currency: "INR", amount: 1000 },
      ],
      "USD",
      rates,
    );

    expect(result.baseCurrency).toBe("USD");
    expect(result.convertedTotal).toBe(282);
    expect(result.conversions).toEqual([
      { currency: "USD", amount: 50, rate: 1, rateDate: null, converted: 50 },
      { currency: "EUR", amount: 200, rate: 1.1, rateDate: "2026-07-01", converted: 220 },
      { currency: "INR", amount: 1000, rate: 0.012, rateDate: "2026-07-15", converted: 12 },
    ]);
    expect(result.missingRates).toEqual([]);
  });

  it("excludes currencies without a rate and reports them in missingRates", () => {
    const rates = new Map([["EUR", { rate: 1.1, asOfDate: "2026-07-01" }]]);

    const result = convertAmounts(
      [
        { currency: "EUR", amount: 100 },
        { currency: "GBP", amount: 100 },
      ],
      "USD",
      rates,
    );

    expect(result.convertedTotal).toBe(110);
    expect(result.conversions).toHaveLength(1);
    expect(result.conversions[0]!.currency).toBe("EUR");
    expect(result.missingRates).toEqual(["GBP"]);
  });

  it("rounds converted amounts to 2 decimals", () => {
    const rates = new Map([["EUR", { rate: 1.23456789, asOfDate: "2026-07-01" }]]);

    const result = convertAmounts([{ currency: "EUR", amount: 33.33 }], "USD", rates);

    expect(result.conversions[0]!.converted).toBe(41.15);
    expect(result.convertedTotal).toBe(41.15);
  });

  it("returns an empty result for empty input", () => {
    const result = convertAmounts([], "USD", new Map());

    expect(result).toEqual({
      baseCurrency: "USD",
      convertedTotal: 0,
      conversions: [],
      missingRates: [],
    });
  });
});
