import {
  UnconfiguredJurisdictionError,
  determineTax,
  isWellFormedTaxId,
} from "./tax-determination";
import { TAX_RATES_VERSION } from "./tax-rates";

const NET = 100_000; // ₹1,000.00 or $1,000.00 in minor units

describe("India", () => {
  it("splits an intra-state supply across CGST and SGST", () => {
    // Not cosmetic: the two heads are remitted to different authorities.
    const tax = determineTax(NET, { country: "IN", state: "KA" });

    expect(tax.treatment).toBe("gst-intra-state");
    expect(tax.components.map((c) => c.name)).toEqual(["CGST", "SGST"]);
    expect(tax.taxMinor).toBe(18_000);
  });

  it("charges IGST on an inter-state supply", () => {
    const tax = determineTax(NET, { country: "IN", state: "MH" });

    expect(tax.treatment).toBe("gst-inter-state");
    expect(tax.components).toHaveLength(1);
    expect(tax.taxMinor).toBe(18_000);
  });

  it("charges the same total either way", () => {
    // The split changes who is paid, not what the customer pays.
    const intra = determineTax(NET, { country: "IN", state: "KA" });
    const inter = determineTax(NET, { country: "IN", state: "MH" });

    expect(intra.taxMinor).toBe(inter.taxMinor);
  });

  it("treats a buyer with no state as inter-state, the safer default", () => {
    // Under-charging two heads is worse than charging the same total to one.
    expect(determineTax(NET, { country: "IN" }).treatment).toBe("gst-inter-state");
  });

  it("splits an odd amount so the heads still sum to the tax line", () => {
    // Rounding the total and halving it is how an invoice ends up with heads
    // that do not add up.
    const tax = determineTax(333, { country: "IN", state: "KA" });
    const summed = tax.components.reduce((total, c) => total + c.amountMinor, 0);

    expect(summed).toBe(tax.taxMinor);
    expect(tax.grossMinor).toBe(tax.netMinor + tax.taxMinor);
  });
});

describe("the European Union", () => {
  it("reverse-charges a VAT-registered business", () => {
    const tax = determineTax(NET, { country: "DE", taxId: "DE123456789" });

    expect(tax.treatment).toBe("vat-reverse-charge");
    expect(tax.taxMinor).toBe(0);
    expect(tax.reason).toContain("accounts for the tax");
  });

  it("charges local VAT to a customer with no registration number", () => {
    // Without a number we cannot treat them as a business, so the consumer rate
    // applies -- assuming otherwise is how the seller ends up owing it.
    const tax = determineTax(NET, { country: "DE" });

    expect(tax.treatment).toBe("vat");
    expect(tax.taxMinor).toBe(19_000);
  });

  it("charges each member state its own rate", () => {
    expect(determineTax(NET, { country: "IE" }).taxMinor).toBe(23_000);
    expect(determineTax(NET, { country: "FR" }).taxMinor).toBe(20_000);
    expect(determineTax(NET, { country: "IT" }).taxMinor).toBe(22_000);
  });

  it("refuses a malformed registration number rather than reverse-charging on it", () => {
    // A typo would otherwise zero-rate a consumer sale.
    const tax = determineTax(NET, { country: "DE", taxId: "not-a-vat-number" });

    expect(tax.treatment).toBe("vat");
    expect(tax.taxMinor).toBeGreaterThan(0);
  });

  it("records the number it was given, even when it did not accept it", () => {
    // The input is part of the determination; dropping it makes the invoice
    // unreproducible and the dispute unanswerable.
    const tax = determineTax(NET, { country: "DE", taxId: "not-a-vat-number" });
    expect(tax.inputs.taxId).toBe("NOT-A-VAT-NUMBER");
  });
});

describe("elsewhere", () => {
  it("applies the configured United States rate, which is currently nil", () => {
    // Nexus in no state, so the rate is zero -- and the treatment says sales-tax
    // rather than pretending the sale is untaxed in principle.
    const tax = determineTax(NET, { country: "US", state: "CA" });

    expect(tax.treatment).toBe("sales-tax");
    expect(tax.taxMinor).toBe(0);
  });

  it("applies configured rates for the rest", () => {
    expect(determineTax(NET, { country: "GB" }).taxMinor).toBe(20_000);
    expect(determineTax(NET, { country: "AE" }).taxMinor).toBe(500 * 10);
    expect(determineTax(NET, { country: "SG" }).taxMinor).toBe(900 * 10);
  });
});

describe("failing loudly", () => {
  it("refuses a jurisdiction nobody has configured", () => {
    // Charging zero by default is a liability that surfaces at audit rather than
    // at checkout, which is the worst possible time to find it.
    expect(() => determineTax(NET, { country: "BR" })).toThrow(UnconfiguredJurisdictionError);
  });

  it("refuses an absent country rather than guessing one", () => {
    expect(() => determineTax(NET, { country: "" })).toThrow(UnconfiguredJurisdictionError);
  });

  it("names the jurisdiction, so the error is actionable", () => {
    expect(() => determineTax(NET, { country: "BR" })).toThrow(/"BR"/);
  });
});

describe("exemption", () => {
  it("charges nothing when an exemption has been accepted", () => {
    const tax = determineTax(NET, { country: "IN", state: "KA", isExempt: true });

    expect(tax.treatment).toBe("exempt");
    expect(tax.taxMinor).toBe(0);
    expect(tax.grossMinor).toBe(NET);
  });

  it("still records the exemption as an input", () => {
    expect(determineTax(NET, { country: "IN", isExempt: true }).inputs.isExempt).toBe(true);
  });
});

describe("what is stored", () => {
  it("returns every input the determination was made from", () => {
    const tax = determineTax(NET, { country: "DE", state: "BY", taxId: "DE123456789" });

    expect(tax.inputs).toEqual({
      sellerCountry: "IN",
      buyerCountry: "DE",
      buyerState: "BY",
      taxId: "DE123456789",
      isExempt: false,
      ratesVersion: TAX_RATES_VERSION,
    });
  });

  it("carries the rates version, so an old invoice reproduces", () => {
    // Without it, reproducing a two-year-old invoice means guessing which rates
    // were in force, and "why was I charged this" becomes "because that is what
    // the code says today".
    expect(determineTax(NET, { country: "GB" }).inputs.ratesVersion).toBe(TAX_RATES_VERSION);
  });

  it("explains itself in words an invoice can print", () => {
    expect(determineTax(NET, { country: "DE", taxId: "DE123456789" }).reason.length)
      .toBeGreaterThan(10);
  });
});

describe("isWellFormedTaxId", () => {
  it("accepts a real-shaped GSTIN and rejects a near miss", () => {
    expect(isWellFormedTaxId("IN", "29ABCDE1234F1Z5")).toBe(true);
    expect(isWellFormedTaxId("IN", "29ABCDE1234F1Z")).toBe(false);
  });

  it("is format only — whether the number exists is the authority's question", () => {
    expect(isWellFormedTaxId("GB", "GB123456789")).toBe(true);
  });

  it("requires one where the jurisdiction defines a shape", () => {
    expect(isWellFormedTaxId("IN", null)).toBe(false);
    expect(isWellFormedTaxId("IN", "  ")).toBe(false);
  });

  it("accepts anything where no shape is defined, rather than inventing one", () => {
    expect(isWellFormedTaxId("US", null)).toBe(true);
  });
});
