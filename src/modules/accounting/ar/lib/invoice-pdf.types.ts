/**
 * The plain data object the tax-invoice PDF renders from — never an ORM row.
 * Money is integer minor units throughout.
 */

/** A tax component as the engine froze it — CGST/SGST/IGST/CESS/VAT/…. */
export interface InvoicePdfTaxComponent {
  component: string;
  jurisdiction?: string | null;
  /** Basis points: 1800 = 18.00%. */
  rateBp: number;
  taxableMinor: number;
  taxMinor: number;
}

export interface InvoicePdfLine {
  lineNo: number;
  description: string;
  /** HSN/SAC in India, generic commodity code elsewhere. M6 requires it. */
  commodityCode: string | null;
  /** Thousandths, so 2.5 hours is 2500. */
  quantityMilli: number;
  unit: string | null;
  unitPriceMinor: number;
  discountMinor: number;
  /** Taxable value of the line, after discount. */
  taxableMinor: number;
  taxMinor: number;
  grossMinor: number;
  taxComponents: InvoicePdfTaxComponent[];
}

export interface InvoicePdfParty {
  name: string;
  legalName?: string | null;
  /** GSTIN / VAT id / tax id. Null prints as "Unregistered". */
  taxRegistrationNumber: string | null;
  /** The label above that number — "GSTIN" for India, "VAT No." elsewhere. */
  taxRegistrationLabel?: string | null;
  addressLines: string[];
  stateCode?: string | null;
  countryCode?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface InvoicePdfData {
  documentType: "INVOICE" | "CREDIT_NOTE";
  /** Never null: only a posted document has a number, and only it gets a PDF. */
  documentNumber: string;
  documentDate: string;
  dueDate?: string | null;
  currency: string;

  seller: InvoicePdfParty;
  buyer: InvoicePdfParty;

  /** Place of supply — the POS state code in India. M6 requires it. */
  placeOfSupply?: string | null;
  /** M6 requires the document to say whether reverse charge applies. */
  reverseCharge: boolean;
  supplyNature?: string | null;

  /** A credit note points back at the invoice it corrects. */
  originalDocumentNumber?: string | null;
  originalDocumentDate?: string | null;

  lines: InvoicePdfLine[];
  /** Components rolled up across lines, for the summary table. */
  taxSummary: InvoicePdfTaxComponent[];

  netMinor: number;
  taxMinor: number;
  roundingMinor: number;
  grossMinor: number;

  memo?: string | null;
  reference?: string | null;
  /** Injectable so a test renders a byte-stable document. */
  generatedAt?: Date;
}
