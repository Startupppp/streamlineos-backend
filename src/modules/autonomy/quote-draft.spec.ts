import { draftQuoteFromDeal, toMajorUnits, type DealForQuote } from "./quote-draft";

const NOW = new Date("2026-08-24T00:00:00.000Z");
const deal = (over: Partial<DealForQuote> = {}): DealForQuote => ({
  name: "Acme renewal",
  valueMinor: 123_456,
  currency: "INR",
  ...over,
});

describe("draftQuoteFromDeal", () => {
  it("prices from the deal's stored minor units", () => {
    const result = draftQuoteFromDeal(deal(), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.draft.subject).toBe("Quote for Acme renewal");
    expect(result.draft.lineItems).toEqual([
      { description: "Acme renewal", quantity: 1, unitPrice: 1234.56 },
    ]);
  });

  it("dates the quote forward rather than leaving it open", () => {
    const result = draftQuoteFromDeal(deal(), NOW);
    if (!result.ok) throw new Error("expected a draft");
    expect(result.draft.validUntil).toBe("2026-09-07");
  });

  describe("refusing", () => {
    /**
     * The important half. Without it a valueless deal produces a quote for
     * nothing and sends it — and "the system emailed my customer a zero" is not
     * a failure a confidence threshold catches.
     */
    it("refuses a deal with no value", () => {
      for (const valueMinor of [0, -1, Number.NaN]) {
        const result = draftQuoteFromDeal(deal({ valueMinor }), NOW);
        expect(result.ok).toBe(false);
      }
    });

    it("refuses a deal with no name", () => {
      expect(draftQuoteFromDeal(deal({ name: "   " }), NOW).ok).toBe(false);
    });
  });
});

describe("toMajorUnits", () => {
  it("does not let float arithmetic reach the customer", () => {
    // The inverse of the trap ticket 08 recorded: 1234.56 * 100 is
    // 123455.99999999999, and the same class of error divides too.
    expect(toMajorUnits(123_456)).toBe(1234.56);
    expect(toMajorUnits(1)).toBe(0.01);
    expect(toMajorUnits(999_999_99)).toBe(999999.99);
  });
});
