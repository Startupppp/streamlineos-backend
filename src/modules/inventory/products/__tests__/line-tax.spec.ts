import { BadRequestException } from "@nestjs/common";
import {
  computeLineTax,
  resolveTaxSnapshot,
  type ProductTaxClassification,
} from "../lib/line-tax";

/**
 * E2 — the tax arithmetic, and the rules that decide which arithmetic applies.
 *
 * Every expected figure below is written out by hand and stated as a literal.
 * The test never recomputes the formula it is checking: two specs in this repo
 * were found asserting `mulDec(a, b)` against `mulDec(a, b)`, which agrees with
 * itself under every possible defect and cannot fail.
 *
 * The rule being pinned: `tax = amount × (rate / 100)`, where `rate / 100` is
 * exact (a scale-2 percent divided by 100 lands at scale 4) and the single
 * multiplication rounds **half-up at the fourth decimal**.
 */

interface TaxCase {
  amount: string;
  rate: string;
  /** The exact mathematical product, written out, so the rounding is visible. */
  exact: string;
  /** What the column must hold. */
  expected: string;
  why: string;
}

const TAX_CASES: readonly TaxCase[] = [
  {
    amount: "1250.0000",
    rate: "18.00",
    exact: "225",
    expected: "225.0000",
    why: "the ordinary case — exact at 4dp, nothing to round",
  },
  {
    amount: "1000.0000",
    rate: "2.50",
    exact: "25",
    expected: "25.0000",
    why: "a rate with two decimals is still exact once divided by 100",
  },
  {
    amount: "999.9900",
    rate: "5.00",
    exact: "49.9995",
    expected: "49.9995",
    why: "lands exactly on the fourth decimal",
  },
  {
    amount: "1234.5678",
    rate: "18.00",
    exact: "222.222204",
    expected: "222.2222",
    why: "fifth decimal is 0, so half-up truncates",
  },
  {
    amount: "333.3333",
    rate: "18.00",
    exact: "59.999994",
    expected: "60.0000",
    why: "0.000094 past the fourth decimal rounds up, and carries all the way",
  },
  {
    amount: "7777.7777",
    rate: "12.00",
    exact: "933.333324",
    expected: "933.3333",
    why: "0.000024 past the fourth decimal rounds down",
  },
  {
    amount: "0.0003",
    rate: "18.00",
    exact: "0.000054",
    expected: "0.0001",
    why: "the smallest taxable value still rounds up rather than vanishing",
  },
  {
    amount: "0.0001",
    rate: "12.00",
    exact: "0.000012",
    expected: "0.0000",
    why: "below half of the fourth decimal, so it does vanish — half-up, not always-up",
  },
  {
    amount: "100.0000",
    rate: "0.00",
    exact: "0",
    expected: "0.0000",
    why: "a zero rate is arithmetic, not a special case",
  },
  {
    amount: "18500000.0000",
    rate: "28.00",
    exact: "5180000",
    expected: "5180000.0000",
    why: "a figure large enough to have lost precision as a float",
  },
];

const TAXABLE: ProductTaxClassification = {
  hsnCode: "84713010",
  taxTreatment: "TAXABLE",
  gstRate: "18.00",
};

describe("E2 line tax arithmetic", () => {
  it.each(TAX_CASES)("$amount at $rate% is $expected ($why)", ({ amount, rate, expected }) => {
    expect(computeLineTax(amount, rate)).toBe(expected);
  });

  it("never reaches a float on the way through", () => {
    // 18,500,000 × 0.28 is one of the products IEEE 754 gets wrong by a hair.
    // The literal is the whole assertion: if this ever came back
    // "5180000.0000000005" or "5179999.9999" a float crept in.
    expect(computeLineTax("18500000.0000", "28.00")).toBe("5180000.0000");
  });
});

describe("E2 tax snapshot resolution", () => {
  it("records nothing while the gst pack is off, and still computes the caller's rate", () => {
    const snapshot = resolveTaxSnapshot({
      classification: null,
      gstMode: "REGULAR",
      documentKind: "PURCHASE",
      taxableAmount: "1250.0000",
      requestedRate: "18.00",
    });
    expect(snapshot).toEqual({
      hsnCode: null,
      taxTreatment: null,
      gstMode: null,
      taxRate: "18.00",
      taxAmount: "225.0000",
    });
  });

  it("takes the SKU's default rate when the line does not name one", () => {
    const snapshot = resolveTaxSnapshot({
      classification: TAXABLE,
      gstMode: "REGULAR",
      documentKind: "SALE",
      taxableAmount: "1250.0000",
    });
    expect(snapshot).toEqual({
      hsnCode: "84713010",
      taxTreatment: "TAXABLE",
      gstMode: "REGULAR",
      taxRate: "18.00",
      taxAmount: "225.0000",
    });
  });

  it("lets the line override the SKU's default rate", () => {
    const snapshot = resolveTaxSnapshot({
      classification: TAXABLE,
      gstMode: "REGULAR",
      documentKind: "PURCHASE",
      taxableAmount: "1250.0000",
      requestedRate: "5.00",
    });
    expect(snapshot.taxRate).toBe("5.00");
    expect(snapshot.taxAmount).toBe("62.5000");
  });

  it.each(["EXEMPT", "NIL_RATED", "ZERO_RATED", "NON_GST"] as const)(
    "forces %s goods to a zero rate and records the treatment",
    (treatment) => {
      const snapshot = resolveTaxSnapshot({
        classification: { hsnCode: "1006", taxTreatment: treatment, gstRate: null },
        gstMode: "REGULAR",
        documentKind: "SALE",
        taxableAmount: "1250.0000",
      });
      // The treatment survives onto the line: "taxable at 0%" and "nil rated"
      // are the same figure and different rows in a return.
      expect(snapshot.taxTreatment).toBe(treatment);
      expect(snapshot.taxRate).toBe("0.00");
      expect(snapshot.taxAmount).toBe("0.0000");
    },
  );

  it("refuses a rate on goods that are not taxable", () => {
    expect(() =>
      resolveTaxSnapshot({
        classification: { hsnCode: "1006", taxTreatment: "EXEMPT", gstRate: null },
        gstMode: "REGULAR",
        documentKind: "SALE",
        taxableAmount: "1250.0000",
        requestedRate: "5.00",
      }),
    ).toThrow(BadRequestException);
  });

  it("refuses outward tax under the composition scheme", () => {
    // The rule E2 names: a composition dealer may not expose a GST split on a
    // sale, because it is an invoice they are not allowed to raise.
    expect(() =>
      resolveTaxSnapshot({
        classification: TAXABLE,
        gstMode: "COMPOSITION",
        documentKind: "SALE",
        taxableAmount: "1250.0000",
        requestedRate: "18.00",
      }),
    ).toThrow(BadRequestException);
  });

  it("zeroes outward tax under the composition scheme when the line names no rate", () => {
    const snapshot = resolveTaxSnapshot({
      classification: TAXABLE,
      gstMode: "COMPOSITION",
      documentKind: "SALE",
      taxableAmount: "1250.0000",
    });
    // The SKU says 18%. The registration overrules it, and the mode is recorded
    // so the document can still explain itself years later.
    expect(snapshot.taxRate).toBe("0.00");
    expect(snapshot.taxAmount).toBe("0.0000");
    expect(snapshot.gstMode).toBe("COMPOSITION");
    expect(snapshot.hsnCode).toBe("84713010");
  });

  it("still taxes purchases under the composition scheme", () => {
    // The half that is easy to get wrong. A composition dealer cannot collect
    // tax; it very much still pays it, and zeroing the purchase side would
    // understate what the business owes its suppliers.
    const snapshot = resolveTaxSnapshot({
      classification: TAXABLE,
      gstMode: "COMPOSITION",
      documentKind: "PURCHASE",
      taxableAmount: "1250.0000",
    });
    expect(snapshot.taxRate).toBe("18.00");
    expect(snapshot.taxAmount).toBe("225.0000");
    expect(snapshot.gstMode).toBe("COMPOSITION");
  });

  it("treats an unclassified SKU as taxable at no rate rather than guessing one", () => {
    const snapshot = resolveTaxSnapshot({
      classification: { hsnCode: null, taxTreatment: null, gstRate: null },
      gstMode: "REGULAR",
      documentKind: "SALE",
      taxableAmount: "1250.0000",
    });
    expect(snapshot.taxTreatment).toBe("TAXABLE");
    expect(snapshot.taxRate).toBe("0.00");
    expect(snapshot.taxAmount).toBe("0.0000");
  });
});
