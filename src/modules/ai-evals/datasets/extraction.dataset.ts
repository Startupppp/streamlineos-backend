export interface ExtractionExpected {
  vendor?: string;
  totalAmount?: number;
  currency?: string;
  invoiceNumber?: string;
  date?: string;
}

export interface ExtractionCase {
  name: string;
  documentText: string;
  expected: ExtractionExpected;
  fieldsThatMustBeNullWhenAbsent: string[];
}

export const EXTRACTION_DATASET: readonly ExtractionCase[] = [
  {
    name: "full-invoice",
    documentText:
      "INVOICE\nVendor: Acme Supplies Ltd\nInvoice #: INV-2026-0042\nDate: 2026-07-01\n" +
      "Subtotal: $1,200.00\nTax: $120.00\nTotal: $1,320.00\nCurrency: USD",
    expected: {
      vendor: "Acme Supplies Ltd",
      totalAmount: 1320,
      currency: "USD",
      invoiceNumber: "INV-2026-0042",
      date: "2026-07-01",
    },
    fieldsThatMustBeNullWhenAbsent: [],
  },
  {
    name: "missing-date",
    documentText:
      "Receipt\nVendor: Office World\nInvoice No: REC-999\nTotal Amount: $450.50 USD",
    expected: {
      vendor: "Office World",
      totalAmount: 450.50,
      currency: "USD",
      invoiceNumber: "REC-999",
    },
    fieldsThatMustBeNullWhenAbsent: ["documentDate"],
  },
  {
    name: "missing-vendor",
    documentText:
      "Invoice Date: 2026-06-15\nInvoice Number: 7890\nTotal: EUR 2,500",
    expected: {
      totalAmount: 2500,
      currency: "EUR",
      invoiceNumber: "7890",
      date: "2026-06-15",
    },
    fieldsThatMustBeNullWhenAbsent: ["vendor"],
  },
  {
    name: "no-total-amount",
    documentText:
      "Bill from TechVendor Inc\nInvoice: TV-123\nDate: 2026-05-20\nCurrency: GBP\nSee attached for breakdown.",
    expected: {
      vendor: "TechVendor Inc",
      currency: "GBP",
      invoiceNumber: "TV-123",
      date: "2026-05-20",
    },
    fieldsThatMustBeNullWhenAbsent: ["totalAmount", "subtotalAmount", "taxAmount"],
  },
  {
    name: "minimal-data",
    documentText: "Thank you for your purchase. Your order has been placed.",
    expected: {},
    fieldsThatMustBeNullWhenAbsent: ["documentDate", "documentNumber", "subtotalAmount", "taxAmount", "totalAmount"],
  },
  {
    name: "multi-currency-eur",
    documentText:
      "Rechnung\nLieferant: Müller GmbH\nRechnungsnummer: R-2026-55\nDatum: 2026-07-10\n" +
      "Nettobetrag: 800,00 EUR\nMwSt. (19%): 152,00 EUR\nGesamtbetrag: 952,00 EUR",
    expected: {
      vendor: "Müller GmbH",
      totalAmount: 952,
      currency: "EUR",
      invoiceNumber: "R-2026-55",
      date: "2026-07-10",
    },
    fieldsThatMustBeNullWhenAbsent: [],
  },
  {
    name: "completely-empty-doc",
    documentText: "",
    expected: {},
    fieldsThatMustBeNullWhenAbsent: ["vendor", "documentDate", "documentNumber", "totalAmount", "subtotalAmount", "taxAmount"],
  },
  {
    name: "full-with-line-items",
    documentText:
      "INVOICE\nFrom: CloudHost Services\nInvoice: CH-20260715\nDate: 2026-07-15\n" +
      "Item 1: Server hosting x3 @ $100 = $300\n" +
      "Item 2: Support plan @ $50/mo = $50\n" +
      "Subtotal: $350\nTax (10%): $35\nTotal: $385 USD",
    expected: {
      vendor: "CloudHost Services",
      totalAmount: 385,
      currency: "USD",
      invoiceNumber: "CH-20260715",
      date: "2026-07-15",
    },
    fieldsThatMustBeNullWhenAbsent: [],
  },
] as const;
