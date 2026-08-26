/**
 * The tax invoice has to be *correct*, not pretty — `05-prd-gst-india.md` M6
 * lists the fields a printed tax invoice must carry, and this reads the text
 * back out of the rendered PDF to prove each one is really on the page rather
 * than trusting that the draw call happened.
 */
import pdfParse from "pdf-parse";
import { generateInvoicePdf, sanitizeForPdf, type InvoicePdfData } from "./invoice-pdf";

const SELLER_GSTIN = "29AABCU9603R1ZM";
const BUYER_GSTIN = "27AAACT2727Q1ZW";

/** Rendered text, with pdf-parse's line breaks flattened to single spaces. */
async function readText(buffer: Buffer): Promise<string> {
  const parsed = await pdfParse(buffer);
  return parsed.text.replace(/\s+/g, " ");
}

function intraStateInvoice(overrides: Partial<InvoicePdfData> = {}): InvoicePdfData {
  return {
    documentType: "INVOICE",
    documentNumber: "INV/2026-27/0001",
    documentDate: "2026-08-25",
    dueDate: "2026-09-24",
    currency: "INR",
    seller: {
      name: "Umbrella Technologies",
      legalName: "Umbrella Technologies Private Limited",
      taxRegistrationNumber: SELLER_GSTIN,
      taxRegistrationLabel: "GSTIN",
      addressLines: ["4th Floor, Prestige Tower", "Bengaluru, Karnataka 560001"],
      stateCode: "29",
      countryCode: "IN",
    },
    buyer: {
      name: "Acme Industries",
      legalName: "Acme Industries LLP",
      taxRegistrationNumber: BUYER_GSTIN,
      taxRegistrationLabel: "GSTIN",
      addressLines: ["Plot 12, Andheri East", "Mumbai, Maharashtra 400069"],
      stateCode: "27",
      countryCode: "IN",
    },
    placeOfSupply: "29",
    reverseCharge: false,
    supplyNature: "domestic_b2b",
    lines: [
      {
        lineNo: 1,
        description: "Software implementation services",
        commodityCode: "998314",
        quantityMilli: 2_000,
        unit: "day",
        unitPriceMinor: 50_000,
        discountMinor: 0,
        taxableMinor: 100_000,
        taxMinor: 18_000,
        grossMinor: 118_000,
        taxComponents: [
          { component: "CGST", rateBp: 900, taxableMinor: 100_000, taxMinor: 9_000 },
          { component: "SGST", rateBp: 900, taxableMinor: 100_000, taxMinor: 9_000 },
        ],
      },
    ],
    taxSummary: [
      { component: "CGST", rateBp: 900, taxableMinor: 100_000, taxMinor: 9_000 },
      { component: "SGST", rateBp: 900, taxableMinor: 100_000, taxMinor: 9_000 },
    ],
    netMinor: 100_000,
    taxMinor: 18_000,
    roundingMinor: 0,
    grossMinor: 118_000,
    generatedAt: new Date("2026-08-25T10:00:00.000Z"),
    ...overrides,
  };
}

describe("invoice PDF", () => {
  it("renders a real, non-trivial PDF", async () => {
    const buffer = await generateInvoicePdf(intraStateInvoice());

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    // A blank page is ~900 bytes; anything real is several kilobytes.
    expect(buffer.length).toBeGreaterThan(3_000);

    const parsed = await pdfParse(buffer);
    expect(parsed.numpages).toBe(1);
    expect(parsed.text.trim().length).toBeGreaterThan(200);
  });

  it("carries every M6 tax-invoice print field", async () => {
    const text = await readText(await generateInvoicePdf(intraStateInvoice()));

    // Seller identity, address and GSTIN.
    expect(text).toContain("Umbrella Technologies Private Limited");
    expect(text).toContain("Prestige Tower");
    expect(text).toContain(SELLER_GSTIN);

    // Buyer identity, address and GSTIN.
    expect(text).toContain("Acme Industries LLP");
    expect(text).toContain("Andheri East");
    expect(text).toContain(BUYER_GSTIN);

    // Document type, number and date.
    expect(text).toContain("TAX INVOICE");
    expect(text).toContain("INV/2026-27/0001");
    expect(text).toContain("2026-08-25");

    // HSN/SAC per line.
    expect(text).toContain("998314");

    // Place of supply and the reverse-charge declaration.
    expect(text).toContain("Place of supply");
    expect(text).toContain("Reverse charge");
  });

  it("prints the taxable value, the rate and each tax component", async () => {
    const text = await readText(await generateInvoicePdf(intraStateInvoice()));

    // Taxable value and the split, in major units — 100000 paise is 1000.00.
    expect(text).toContain("1000.00");
    expect(text).toContain("CGST");
    expect(text).toContain("SGST");
    expect(text).toContain("9.00%");
    // 9000 paise of CGST and of SGST, 18000 total.
    expect(text).toContain("90.00");
    expect(text).toContain("180.00");
    expect(text).toContain("1180.00");
    expect(text).toContain("Total payable");
  });

  it("shows IGST as a single component on an inter-state supply", async () => {
    const igst = intraStateInvoice({
      placeOfSupply: "27",
      lines: [
        {
          ...intraStateInvoice().lines[0],
          taxComponents: [
            { component: "IGST", rateBp: 1800, taxableMinor: 100_000, taxMinor: 18_000 },
          ],
        },
      ],
      taxSummary: [
        { component: "IGST", rateBp: 1800, taxableMinor: 100_000, taxMinor: 18_000 },
      ],
    });

    const text = await readText(await generateInvoicePdf(igst));
    expect(text).toContain("IGST");
    expect(text).toContain("18.00%");
    expect(text).not.toContain("CGST");
  });

  it("says so when reverse charge applies", async () => {
    const text = await readText(
      await generateInvoicePdf(intraStateInvoice({ reverseCharge: true })),
    );
    expect(text).toContain("Tax payable under reverse charge");
  });

  it("renders a credit note with the words and the signs reversed", async () => {
    const note = intraStateInvoice({
      documentType: "CREDIT_NOTE",
      documentNumber: "CRN/2026-27/0004",
      originalDocumentNumber: "INV/2026-27/0001",
      originalDocumentDate: "2026-08-25",
    });

    const text = await readText(await generateInvoicePdf(note));

    expect(text).toContain("CREDIT NOTE");
    expect(text).toContain("CRN/2026-27/0004");
    expect(text).toContain("Against invoice");
    expect(text).toContain("INV/2026-27/0001");
    expect(text).toContain("Total credit");
    // The signs: a credit note reduces the receivable.
    expect(text).toContain("-1180.00");
    expect(text).toContain("-1000.00");
    expect(text).not.toContain("Total payable");
  });

  it("keeps the money out of floating point — 3 x 33.33 never becomes 99.98999", async () => {
    const odd = intraStateInvoice({
      lines: [
        {
          lineNo: 1,
          description: "Consulting",
          commodityCode: "998311",
          quantityMilli: 3_000,
          unit: "hr",
          unitPriceMinor: 3_333,
          discountMinor: 0,
          taxableMinor: 9_999,
          taxMinor: 1_800,
          grossMinor: 11_799,
          taxComponents: [
            { component: "IGST", rateBp: 1800, taxableMinor: 9_999, taxMinor: 1_800 },
          ],
        },
      ],
      taxSummary: [{ component: "IGST", rateBp: 1800, taxableMinor: 9_999, taxMinor: 1_800 }],
      netMinor: 9_999,
      taxMinor: 1_800,
      grossMinor: 11_799,
    });

    const text = await readText(await generateInvoicePdf(odd));
    // 3 x 33.33 = 99.99 exactly, and 18% of that is 18.00 — the values the
    // kernel computed, printed at the currency's own scale and no other.
    expect(text).toContain("33.33");
    expect(text).toContain("99.99");
    expect(text).toContain("117.99");
    expect(text).toContain("Total payableINR 117.99");
  });

  it("rolls a long document onto a second page rather than off the bottom", async () => {
    const many = intraStateInvoice({
      lines: Array.from({ length: 45 }, (_, i) => ({
        lineNo: i + 1,
        description: `Retainer month ${i + 1} - platform engineering and support`,
        commodityCode: "998314",
        quantityMilli: 1_000,
        unit: "mo",
        unitPriceMinor: 100_000,
        discountMinor: 0,
        taxableMinor: 100_000,
        taxMinor: 18_000,
        grossMinor: 118_000,
        taxComponents: [
          { component: "IGST", rateBp: 1800, taxableMinor: 100_000, taxMinor: 18_000 },
        ],
      })),
      taxSummary: [
        { component: "IGST", rateBp: 1800, taxableMinor: 4_500_000, taxMinor: 810_000 },
      ],
      netMinor: 4_500_000,
      taxMinor: 810_000,
      grossMinor: 5_310_000,
    });

    const parsed = await pdfParse(await generateInvoicePdf(many));
    expect(parsed.numpages).toBeGreaterThan(1);
    expect(parsed.text).toContain("continued");
    expect(parsed.text.replace(/\s+/g, " ")).toContain("53100.00");
  });

  it("survives a customer name a standard PDF font cannot encode", async () => {
    const unicode = intraStateInvoice();
    unicode.buyer = {
      ...unicode.buyer,
      name: "टाटा कंसल्टेंसी",
      legalName: "Tata — Consultancy ₹ Services",
    };

    // The point is that it renders at all rather than throwing on WinAnsi.
    const buffer = await generateInvoicePdf(unicode);
    expect(buffer.length).toBeGreaterThan(3_000);
    expect(sanitizeForPdf("₹100 — “quoted”")).toBe('Rs.100 - "quoted"');
    expect(sanitizeForPdf("टाटा")).toBe("????");
  });

  it("handles a zero-tax export with no components at all", async () => {
    const exported = intraStateInvoice({
      supplyNature: "export",
      placeOfSupply: null,
      lines: [
        {
          ...intraStateInvoice().lines[0],
          taxMinor: 0,
          grossMinor: 100_000,
          taxComponents: [],
        },
      ],
      taxSummary: [],
      taxMinor: 0,
      grossMinor: 100_000,
    });

    const text = await readText(await generateInvoicePdf(exported));
    expect(text).toContain("No tax on this document");
    expect(text).toContain("Not stated");
    expect(text).toContain("1000.00");
  });
});
