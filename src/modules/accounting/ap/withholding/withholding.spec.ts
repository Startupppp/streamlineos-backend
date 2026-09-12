/**
 * The withholding engines are pure, so they are tested without a database.
 *
 * What matters here is that the *rules* live in the engine and the *numbers*
 * live in `withholding.rates.ts` — every case below is driven by a rate row, and
 * a fixture pack of rows proves nothing in the engine hardcodes a rate.
 */
import { GenericWhtEngine } from "./generic-wht.engine";
import { IndiaTdsEngine } from "./india-tds.engine";
import { WithholdingEngineRegistry } from "./withholding.registry";
import type { WithholdingRateRow } from "./withholding.rates";

const PAYMENT_DATE = "2026-08-25";

describe("GenericWhtEngine", () => {
  const engine = new GenericWhtEngine();

  it("withholds a flat rate from a stated base", () => {
    const result = engine.determine({
      paymentDate: PAYMENT_DATE,
      currency: "EUR",
      baseMinor: 10_000,
      withholdingCode: "WHT_10",
    });

    expect(result.applicable).toBe(true);
    expect(result.rateBp).toBe(1000);
    expect(result.withheldMinor).toBe(1000);
    expect(result.baseMinor - result.withheldMinor).toBe(9000);
  });

  it("withholds nothing when the vendor carries no code", () => {
    const result = engine.determine({
      paymentDate: PAYMENT_DATE,
      currency: "EUR",
      baseMinor: 10_000,
    });
    expect(result.applicable).toBe(false);
    expect(result.withheldMinor).toBe(0);
    expect(result.reason).toMatch(/no withholding code/i);
  });

  it("names an unknown code rather than silently deducting zero", () => {
    const result = engine.determine({
      paymentDate: PAYMENT_DATE,
      currency: "EUR",
      baseMinor: 10_000,
      withholdingCode: "NOT_A_CODE",
    });
    expect(result.applicable).toBe(false);
    expect(result.reason).toContain("NOT_A_CODE");
  });

  it("honours a certificate rate over the table", () => {
    const result = engine.determine({
      paymentDate: PAYMENT_DATE,
      currency: "EUR",
      baseMinor: 10_000,
      withholdingCode: "WHT_10",
      overrideRateBp: 200,
      overrideReason: "Treaty relief certificate",
    });
    expect(result.rateBp).toBe(200);
    expect(result.withheldMinor).toBe(200);
    expect(result.reason).toBe("Treaty relief certificate");
  });
});

describe("IndiaTdsEngine", () => {
  const engine = new IndiaTdsEngine();

  it("deducts 10% under 194J and reports both identifiers", () => {
    const result = engine.determine({
      paymentDate: PAYMENT_DATE,
      currency: "INR",
      baseMinor: 10_000_000, // ₹100,000.00
      withholdingCode: "194J",
    });

    expect(result.rateBp).toBe(1000);
    expect(result.withheldMinor).toBe(1_000_000);
    expect(result.legacySection).toBe("194J");
    // Both identifiers travel: practice says 194J, the 2025 Act files it
    // under §393, and `ap_withholding` stores each.
    expect(result.paymentCode).toMatch(/^393\//);
  });

  it("resolves the same row from its §393 payment code", () => {
    const bySection = engine.determine({
      paymentDate: PAYMENT_DATE,
      currency: "INR",
      baseMinor: 10_000_000,
      withholdingCode: "194J",
    });
    const byCode = engine.determine({
      paymentDate: PAYMENT_DATE,
      currency: "INR",
      baseMinor: 10_000_000,
      withholdingCode: bySection.paymentCode!,
    });
    expect(byCode.rateBp).toBe(bySection.rateBp);
    expect(byCode.legacySection).toBe("194J");
  });

  it("charges the contractor at 1% for an individual and 2% otherwise", () => {
    const base = { paymentDate: PAYMENT_DATE, currency: "INR", baseMinor: 10_000_000, withholdingCode: "194C" };
    expect(engine.determine({ ...base, payeeType: "individual" }).rateBp).toBe(100);
    expect(engine.determine({ ...base, payeeType: "company" }).rateBp).toBe(200);
  });

  it("deducts nothing below both thresholds, and names why", () => {
    const result = engine.determine({
      paymentDate: PAYMENT_DATE,
      currency: "INR",
      baseMinor: 100_000, // ₹1,000.00
      withholdingCode: "194C",
    });
    expect(result.applicable).toBe(false);
    expect(result.withheldMinor).toBe(0);
    expect(result.legacySection).toBe("194C");
    expect(result.reason).toMatch(/threshold/i);
  });

  it("deducts once the year to date crosses the annual threshold", () => {
    const result = engine.determine({
      paymentDate: PAYMENT_DATE,
      currency: "INR",
      baseMinor: 100_000,
      withholdingCode: "194C",
      cumulativeBaseMinor: 20_000_000,
      payeeType: "company",
    });
    expect(result.applicable).toBe(true);
    expect(result.rateBp).toBe(200);
    expect(result.withheldMinor).toBe(2000);
  });

  it("applies the penal rate when no PAN is on file", () => {
    const result = engine.determine({
      paymentDate: PAYMENT_DATE,
      currency: "INR",
      baseMinor: 10_000_000,
      withholdingCode: "194J",
      taxIdOnFile: false,
    });
    expect(result.rateBp).toBe(2000);
    expect(result.reason).toMatch(/no PAN/i);
  });

  it("lets a lower-deduction certificate beat the thresholds outright", () => {
    const result = engine.determine({
      paymentDate: PAYMENT_DATE,
      currency: "INR",
      baseMinor: 100_000,
      withholdingCode: "194C",
      overrideRateBp: 50,
    });
    expect(result.rateBp).toBe(50);
    expect(result.withheldMinor).toBe(500);
  });

  it("reads rates from dated config, not from the engine", () => {
    // A rate that only comes into force next year must not touch a payment
    // made today — which is the entire point of storing rows, not constants.
    const rows: WithholdingRateRow[] = [
      {
        regime: "INDIA_TDS",
        legacySection: "194J",
        paymentCode: "393/T2/PROFESSIONAL",
        label: "Fees for professional services",
        rateBp: 1000,
        effectiveFrom: "2000-04-01",
        effectiveTo: "2026-08-24",
      },
      {
        regime: "INDIA_TDS",
        legacySection: "194J",
        paymentCode: "393/T2/PROFESSIONAL",
        label: "Fees for professional services",
        rateBp: 500,
        effectiveFrom: "2026-08-25",
      },
    ];
    const dated = new IndiaTdsEngine(rows);
    const before = dated.determine({
      paymentDate: "2026-08-24",
      currency: "INR",
      baseMinor: 10_000_000,
      withholdingCode: "194J",
    });
    const after = dated.determine({
      paymentDate: "2026-08-25",
      currency: "INR",
      baseMinor: 10_000_000,
      withholdingCode: "194J",
    });
    expect(before.rateBp).toBe(1000);
    expect(after.rateBp).toBe(500);
  });
});

describe("WithholdingEngineRegistry", () => {
  const registry = new WithholdingEngineRegistry();

  it("binds the India pack to TDS and everything else to the generic engine", () => {
    expect(registry.forPack("IN").regime).toBe("INDIA_TDS");
    expect(registry.forPack("GENERIC_VAT").regime).toBe("GENERIC_WHT");
    expect(registry.forPack("SOMETHING_UNKNOWN").regime).toBe("GENERIC_WHT");
  });

  it("is a sibling of the tax engine, not a part of it", () => {
    // PRD 10 S3: withholding answers a different question, at a different
    // moment, on a different base. Nothing here imports the VAT/GST engine.
    expect(registry.list().map((e) => e.regime).sort()).toEqual(["GENERIC_WHT", "INDIA_TDS"]);
  });
});
