/**
 * Tax engine acceptance tests — PRD 10 plus the India pack cases from PRD 05.
 *
 * These are pure: no database, no Nest. If determination ever needs a container
 * to be testable, the engine has stopped being a plugin.
 */
import { GenericVatEngine, StubTaxEngine } from "./engines/generic-vat.engine";
import { InGstEngine, stateFromGstin } from "./engines/in-gst.engine";
import { TaxEngineRegistry } from "./tax-engine.registry";
import type {
  ResolvedTaxCode,
  SeedTaxCode,
  TaxContext,
  TaxEngine,
  TaxRateTable,
} from "./tax.types";

const KARNATAKA = "29";
const MAHARASHTRA = "27";
const CHANDIGARH = "04"; // union territory — takes UTGST
const SELLER_GSTIN = `${KARNATAKA}AABCU9603R1ZM`;
const BUYER_KA_GSTIN = `${KARNATAKA}AAACR5055K1Z5`;
const BUYER_MH_GSTIN = `${MAHARASHTRA}AAACR5055K1Z5`;

/** Build the rate table an engine would have been handed for a document date. */
function rateTable(seeds: SeedTaxCode[], onDate = "2026-08-25"): TaxRateTable {
  const byCode = new Map<string, ResolvedTaxCode>();
  let n = 0;
  for (const seed of seeds) {
    const components = seed.rates
      .filter(
        (r) => r.effectiveFrom <= onDate && (!r.effectiveTo || r.effectiveTo >= onDate),
      )
      .map((r) => ({ component: r.component, jurisdiction: r.jurisdiction, rateBp: r.rateBp }));
    if (components.length === 0) continue;
    byCode.set(seed.code, {
      id: `code-${++n}`,
      code: seed.code,
      category: seed.category,
      components,
    });
  }
  const byId = new Map<string, ResolvedTaxCode>();
  for (const c of byCode.values()) if (c.id) byId.set(c.id, c);
  return { byCode, byId };
}

function indiaContext(overrides: Partial<TaxContext> = {}): TaxContext {
  return {
    bookId: "book-1",
    direction: "sale",
    documentDate: "2026-08-25",
    currency: "INR",
    supplyNature: "domestic_b2b",
    from: { countryCode: "IN", region: KARNATAKA },
    to: { countryCode: "IN", region: KARNATAKA },
    sellerRegistrations: [
      { regime: "GST_IN", number: SELLER_GSTIN, region: KARNATAKA, countryCode: "IN" },
    ],
    buyerRegistrations: [
      { regime: "GST_IN", number: BUYER_KA_GSTIN, region: KARNATAKA, countryCode: "IN" },
    ],
    lines: [
      { id: "line-1", taxableMinor: 1_000_000, taxCategory: "standard", commodityCode: "998314" },
    ],
    ...overrides,
  };
}

const inEngine: TaxEngine = new InGstEngine();
const inRates = rateTable(new InGstEngine().seedCodes());

/* --------------------------------------------------------- PRD 10 test 1 */

describe("registry", () => {
  it("lists India as enabled and the United States as a stub", () => {
    const registry = new TaxEngineRegistry();
    const packs = Object.fromEntries(registry.list().map((e) => [e.pack, e.status]));
    expect(packs.IN).toBe("enabled");
    expect(packs.GENERIC_VAT).toBe("enabled");
    expect(packs.US).toBe("stub");
    expect(packs.EU).toBe("stub");
    expect(packs.GB).toBe("stub");
  });

  it("throws for a pack nobody registered rather than returning undefined", () => {
    const registry = new TaxEngineRegistry();
    expect(() => registry.get("ATLANTIS")).toThrow(/no tax engine is registered/i);
  });
});

/* ------------------------------------------------- PRD 05 tests 1, 2, 3, 7 */

describe("India GST — place of supply drives the split", () => {
  it("splits an intra-state 18% supply into equal CGST and SGST (PRD 05 acceptance 1)", () => {
    const result = inEngine.determine(indiaContext(), inRates);

    expect(result.errors).toEqual([]);
    const [line] = result.lines;
    expect(line.taxCode).toBe("IN_GST_18");
    expect(line.components).toHaveLength(2);

    const byCode = Object.fromEntries(line.components.map((c) => [c.code, c]));
    expect(byCode.CGST.rateBp).toBe(900);
    expect(byCode.SGST.rateBp).toBe(900);
    expect(byCode.CGST.taxMinor).toBe(90_000);
    expect(byCode.SGST.taxMinor).toBe(90_000);
    // The invariant that matters: the halves are equal and sum to the slab.
    expect(byCode.CGST.taxMinor).toBe(byCode.SGST.taxMinor);
    expect(line.totalTaxMinor).toBe(180_000);
    expect(byCode.IGST).toBeUndefined();
  });

  it("charges IGST only on an inter-state supply (PRD 05 acceptance 2)", () => {
    const result = inEngine.determine(
      indiaContext({
        to: { countryCode: "IN", region: MAHARASHTRA },
        buyerRegistrations: [
          { regime: "GST_IN", number: BUYER_MH_GSTIN, region: MAHARASHTRA, countryCode: "IN" },
        ],
      }),
      inRates,
    );

    const [line] = result.lines;
    expect(line.components).toHaveLength(1);
    expect(line.components[0].code).toBe("IGST");
    expect(line.components[0].rateBp).toBe(1800);
    expect(line.components[0].taxMinor).toBe(180_000);
    // Never IGST alongside CGST on the same line.
    expect(line.components.some((c) => c.code === "CGST")).toBe(false);
  });

  it("splits a B2C intra-state supply the same way (PRD 05 acceptance 3)", () => {
    const result = inEngine.determine(
      indiaContext({ supplyNature: "domestic_b2c", buyerRegistrations: [] }),
      inRates,
    );

    expect(result.errors).toEqual([]);
    const codes = result.lines[0].components.map((c) => c.code).sort();
    expect(codes).toEqual(["CGST", "SGST"]);
    expect(result.totalTaxMinor).toBe(180_000);
  });

  it("splits a 5% slab into 2.5 and 2.5 (PRD 05 acceptance 7)", () => {
    const result = inEngine.determine(
      indiaContext({
        lines: [{ id: "line-1", taxableMinor: 1_000_000, taxCategory: "reduced" }],
      }),
      inRates,
    );

    const byCode = Object.fromEntries(result.lines[0].components.map((c) => [c.code, c]));
    expect(byCode.CGST.rateBp).toBe(250);
    expect(byCode.SGST.rateBp).toBe(250);
    expect(byCode.CGST.taxMinor).toBe(25_000);
    expect(result.totalTaxMinor).toBe(50_000);
  });

  it("uses UTGST in a union territory, never alongside SGST", () => {
    const result = inEngine.determine(
      indiaContext({
        from: { countryCode: "IN", region: CHANDIGARH },
        to: { countryCode: "IN", region: CHANDIGARH },
        sellerRegistrations: [
          {
            regime: "GST_IN",
            number: `${CHANDIGARH}AABCU9603R1ZM`,
            region: CHANDIGARH,
            countryCode: "IN",
          },
        ],
        buyerRegistrations: [],
        supplyNature: "domestic_b2c",
      }),
      inRates,
    );

    const codes = result.lines[0].components.map((c) => c.code).sort();
    expect(codes).toEqual(["CGST", "UTGST"]);
    expect(codes).not.toContain("SGST");
  });

  it("reads the place of supply from the buyer's GSTIN when none is given", () => {
    const result = inEngine.determine(
      indiaContext({
        to: { countryCode: "IN", region: null },
        buyerRegistrations: [
          { regime: "GST_IN", number: BUYER_MH_GSTIN, region: null, countryCode: "IN" },
        ],
      }),
      inRates,
    );
    expect(result.lines[0].components[0].code).toBe("IGST");
  });

  it("extracts the state code from a GSTIN", () => {
    expect(stateFromGstin(SELLER_GSTIN)).toBe("29");
    expect(stateFromGstin(BUYER_MH_GSTIN)).toBe("27");
    expect(stateFromGstin("not-a-gstin")).toBeNull();
  });
});

/* ------------------------------------------------------- PRD 05 test 4, 5 */

describe("India GST — exports and reverse charge", () => {
  it("zero-rates an export and keeps the IGST component visible (PRD 05 acceptance 4)", () => {
    const result = inEngine.determine(
      indiaContext({
        supplyNature: "export",
        to: { countryCode: "US", region: "CA" },
        buyerRegistrations: [],
        flags: { lutOnFile: true },
      }),
      inRates,
    );

    expect(result.errors).toEqual([]);
    const [line] = result.lines;
    expect(line.components).toHaveLength(1);
    expect(line.components[0].code).toBe("IGST");
    expect(line.components[0].rateBp).toBe(0);
    expect(line.components[0].taxMinor).toBe(0);
    expect(result.totalTaxMinor).toBe(0);
  });

  it("charges IGST on an export when the exporter opts to pay it", () => {
    const result = inEngine.determine(
      indiaContext({
        supplyNature: "export",
        to: { countryCode: "US", region: "CA" },
        buyerRegistrations: [],
        flags: { exportWithIgst: true },
      }),
      inRates,
    );
    expect(result.lines[0].components[0].code).toBe("IGST");
    expect(result.lines[0].components[0].taxMinor).toBe(180_000);
  });

  it("treats any non-India destination as an export even if nobody said so", () => {
    const result = inEngine.determine(
      indiaContext({ to: { countryCode: "DE", region: null }, buyerRegistrations: [] }),
      inRates,
    );
    expect(result.totalTaxMinor).toBe(0);
  });

  it("produces both legs for reverse charge (PRD 05 acceptance 5)", () => {
    const result = inEngine.determine(
      indiaContext({
        direction: "purchase",
        supplyNature: "reverse_charge",
        lines: [{ id: "line-1", taxableMinor: 1_000_000, taxCategory: "reverse_charge" }],
      }),
      inRates,
    );

    const roles = result.lines[0].components.map((c) => c.glRole);
    expect(roles).toContain("reverse_charge_input");
    expect(roles).toContain("reverse_charge_output");

    const input = result.lines[0].components.filter((c) => c.glRole === "reverse_charge_input");
    const output = result.lines[0].components.filter((c) => c.glRole === "reverse_charge_output");
    // Equal and opposite, so GST nets to zero on the supply.
    expect(input.reduce((a, c) => a + c.taxMinor, 0)).toBe(
      output.reduce((a, c) => a + c.taxMinor, 0),
    );
  });
});

/* ---------------------------------------------------------- PRD 05 test 6 */

describe("India GST — determination refuses rather than guessing", () => {
  it("errors when the seller has no GSTIN (PRD 05 acceptance 6)", () => {
    const result = inEngine.determine(indiaContext({ sellerRegistrations: [] }), inRates);
    expect(result.lines).toHaveLength(0);
    expect(result.errors[0].code).toBe("SELLER_NOT_REGISTERED");
    expect(result.totalTaxMinor).toBe(0);
  });

  it("errors when a domestic supply has no place of supply", () => {
    const result = inEngine.determine(
      indiaContext({ to: { countryCode: "IN", region: null }, buyerRegistrations: [] }),
      inRates,
    );
    expect(result.errors[0].code).toBe("PLACE_OF_SUPPLY_MISSING");
  });

  it("warns but does not block when HSN is missing on a B2B line", () => {
    const result = inEngine.determine(
      indiaContext({
        lines: [{ id: "line-1", taxableMinor: 1_000_000, taxCategory: "standard" }],
      }),
      inRates,
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings[0].code).toBe("HSN_MISSING");
    expect(result.totalTaxMinor).toBe(180_000);
  });

  it("errors when no rate is configured for the date", () => {
    const empty: TaxRateTable = { byCode: new Map(), byId: new Map() };
    const result = inEngine.determine(indiaContext(), empty);
    expect(result.errors[0].code).toBe("TAX_CODE_UNRESOLVED");
  });
});

/* ---------------------------------------------------------- PRD 10 test 6 */

describe("dated rates", () => {
  it("uses the rate in force on the document date, not the newest one", () => {
    const seeds: SeedTaxCode[] = [
      {
        code: "IN_GST_18",
        name: "GST 18%",
        category: "standard",
        rates: [
          { component: "CGST", jurisdiction: "IN", rateBp: 900, effectiveFrom: "2017-07-01", effectiveTo: "2026-09-30" },
          { component: "SGST", jurisdiction: "IN", rateBp: 900, effectiveFrom: "2017-07-01", effectiveTo: "2026-09-30" },
          // A cut landing on 1 October.
          { component: "CGST", jurisdiction: "IN", rateBp: 250, effectiveFrom: "2026-10-01" },
          { component: "SGST", jurisdiction: "IN", rateBp: 250, effectiveFrom: "2026-10-01" },
        ],
      },
    ];

    const before = inEngine.determine(
      indiaContext({ documentDate: "2026-08-25" }),
      rateTable(seeds, "2026-08-25"),
    );
    expect(before.totalTaxMinor).toBe(180_000);

    const after = inEngine.determine(
      indiaContext({ documentDate: "2026-10-15" }),
      rateTable(seeds, "2026-10-15"),
    );
    expect(after.totalTaxMinor).toBe(50_000);
  });
});

/* ------------------------------------------------------- PRD 10 test 3, 4 */

describe("generic VAT pack", () => {
  const vat: TaxEngine = new GenericVatEngine();
  const vatRates = rateTable(new GenericVatEngine().seedCodes());

  const vatContext = (overrides: Partial<TaxContext> = {}): TaxContext => ({
    bookId: "book-2",
    direction: "sale",
    documentDate: "2026-08-25",
    currency: "EUR",
    supplyNature: "domestic_b2b",
    from: { countryCode: "PT", region: null },
    to: { countryCode: "PT", region: null },
    sellerRegistrations: [{ regime: "VAT_EU", number: "PT123456789", countryCode: "PT" }],
    buyerRegistrations: [],
    lines: [{ id: "line-1", taxableMinor: 10_000, taxCategory: "standard" }],
    ...overrides,
  });

  it("produces one VAT component payable on a sale (PRD 10 acceptance 3)", () => {
    const result = vat.determine(vatContext(), vatRates);
    expect(result.errors).toEqual([]);
    expect(result.lines[0].components).toHaveLength(1);
    expect(result.lines[0].components[0].code).toBe("VAT");
    expect(result.lines[0].components[0].glRole).toBe("output_payable");
    expect(result.lines[0].components[0].taxMinor).toBe(2_000); // 20% of 100.00
  });

  it("produces recoverable input VAT on a purchase (PRD 10 acceptance 4)", () => {
    const result = vat.determine(vatContext({ direction: "purchase" }), vatRates);
    expect(result.lines[0].components[0].glRole).toBe("input_recoverable");
    expect(result.lines[0].components[0].recoverable).toBe(true);
  });

  it("marks blocked input tax as non-recoverable", () => {
    const result = vat.determine(
      vatContext({ direction: "purchase", flags: { blockedInput: true } }),
      vatRates,
    );
    expect(result.lines[0].components[0].recoverable).toBe(false);
  });

  it("zero-rates an export", () => {
    const result = vat.determine(
      vatContext({ supplyNature: "export", to: { countryCode: "US", region: null } }),
      vatRates,
    );
    expect(result.totalTaxMinor).toBe(0);
  });

  it("gives the same document a different answer than pack IN, which is the point", () => {
    const asVat = vat.determine(vatContext(), vatRates);
    const asGst = inEngine.determine(indiaContext(), inRates);

    expect(asVat.lines[0].components.map((c) => c.code)).toEqual(["VAT"]);
    expect(asGst.lines[0].components.map((c) => c.code).sort()).toEqual(["CGST", "SGST"]);
  });
});

/* ---------------------------------------------------------- PRD 10 test 5 */

describe("stub packs", () => {
  it("returns a structured error and never a silent zero", () => {
    const stub = new StubTaxEngine("US", "United States sales tax");
    const result = stub.determine({
      bookId: "book-3",
      direction: "sale",
      documentDate: "2026-08-25",
      currency: "USD",
      supplyNature: "domestic_b2b",
      from: { countryCode: "US", region: "CA" },
      to: { countryCode: "US", region: "NY" },
      sellerRegistrations: [],
      buyerRegistrations: [],
      lines: [{ id: "line-1", taxableMinor: 10_000, taxCategory: "standard" }],
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe("PACK_NOT_CONFIGURED");
    expect(result.totalTaxMinor).toBe(0);
    // The net figures still come back so a preview can render.
    expect(result.lines[0].taxableMinor).toBe(10_000);
    expect(result.lines[0].components).toEqual([]);
  });
});

/* ------------------------------------------------------ tax-inclusive mode */

describe("tax-inclusive pricing", () => {
  it("backs 18% out of a gross figure instead of adding to it", () => {
    const result = inEngine.determine(
      indiaContext({
        taxInclusive: true,
        lines: [{ id: "line-1", taxableMinor: 1_180_000, taxCategory: "standard", commodityCode: "998314" }],
      }),
      inRates,
    );

    const [line] = result.lines;
    expect(line.taxableMinor).toBe(1_000_000);
    expect(line.totalTaxMinor).toBe(180_000);
    // Net plus tax returns the gross the customer was quoted.
    expect(line.taxableMinor + line.totalTaxMinor).toBe(1_180_000);
  });
});

/* ---------------------------------------------------------- PRD 10 test 7 */

describe("determinism", () => {
  it("gives the same answer for the same context every time", () => {
    const a = inEngine.determine(indiaContext(), inRates);
    const b = inEngine.determine(indiaContext(), inRates);
    expect(a).toEqual(b);
  });

  it("matches the golden fixture for an 18% intra-state supply", () => {
    const result = inEngine.determine(indiaContext(), inRates);
    expect({
      taxCode: result.lines[0].taxCode,
      taxable: result.lines[0].taxableMinor,
      components: result.lines[0].components
        .map((c) => ({ code: c.code, rateBp: c.rateBp, taxMinor: c.taxMinor, glRole: c.glRole }))
        .sort((x, y) => x.code.localeCompare(y.code)),
      total: result.totalTaxMinor,
    }).toEqual({
      taxCode: "IN_GST_18",
      taxable: 1_000_000,
      components: [
        { code: "CGST", rateBp: 900, taxMinor: 90_000, glRole: "output_payable" },
        { code: "SGST", rateBp: 900, taxMinor: 90_000, glRole: "output_payable" },
      ],
      total: 180_000,
    });
  });

  it("handles multiple lines at different rates on one document", () => {
    const result = inEngine.determine(
      indiaContext({
        lines: [
          { id: "a", taxableMinor: 1_000_000, taxCategory: "standard", commodityCode: "998314" },
          { id: "b", taxableMinor: 500_000, taxCategory: "reduced", commodityCode: "998315" },
          { id: "c", taxableMinor: 200_000, taxCategory: "zero", commodityCode: "998316" },
        ],
      }),
      inRates,
    );

    expect(result.lines).toHaveLength(3);
    expect(result.lines[0].totalTaxMinor).toBe(180_000);
    expect(result.lines[1].totalTaxMinor).toBe(25_000);
    expect(result.lines[2].totalTaxMinor).toBe(0);
    expect(result.totalTaxMinor).toBe(205_000);
  });

  it("rounds each component half-up to the minor unit", () => {
    // 333.33 at 18% intra-state: 9% of 33333 paise = 2999.97 -> 3000 each side.
    const result = inEngine.determine(
      indiaContext({
        lines: [{ id: "line-1", taxableMinor: 33_333, taxCategory: "standard", commodityCode: "998314" }],
      }),
      inRates,
    );
    const byCode = Object.fromEntries(result.lines[0].components.map((c) => [c.code, c.taxMinor]));
    expect(byCode.CGST).toBe(3_000);
    expect(byCode.SGST).toBe(3_000);
    expect(result.totalTaxMinor).toBe(6_000);
  });
});
