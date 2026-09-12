import type { TaxCategory, TaxGlRole, TaxRegime, TaxSupplyNature } from "../../../db/schema";

/**
 * The tax engine contract (PRD 10).
 *
 * `determine` is **pure**: context in, tax lines out. It reads no database and
 * writes no journal. That is what makes India GST a plugin instead of a set of
 * `if (country === 'IN')` branches through AR and AP, and what makes the
 * golden-fixture tests possible.
 */

export interface TaxPlace {
  countryCode: string;
  /** State, province, or emirate. India and the US cannot determine without it. */
  region?: string | null;
  postalCode?: string | null;
}

export interface TaxContextRegistration {
  regime: TaxRegime;
  number: string;
  region?: string | null;
  countryCode: string;
}

export interface TaxContextLine {
  id: string;
  /** Net of discount, in transaction currency minor units. */
  taxableMinor: number;
  taxCategory: TaxCategory;
  /** HSN/SAC in India, CN/commodity code elsewhere. */
  commodityCode?: string | null;
  /** Force a specific code, with a reason recorded by the caller (S1). */
  forceTaxCodeId?: string | null;
  quantity?: number | null;
  uom?: string | null;
}

export interface TaxContext {
  bookId: string;
  direction: "sale" | "purchase";
  documentDate: string;
  currency: string;
  supplyNature: TaxSupplyNature;
  from: TaxPlace;
  to: TaxPlace;
  sellerRegistrations: TaxContextRegistration[];
  buyerRegistrations: TaxContextRegistration[];
  lines: TaxContextLine[];
  /**
   * When true, `taxableMinor` on each line is **gross** and the engine backs
   * the tax out of it rather than adding on top (PRD 02 M10).
   */
  taxInclusive?: boolean;
  /** Pack-specific switches: `exportWithIgst`, `lutOnFile`, `blockedInput`… */
  flags?: Record<string, boolean>;
}

export interface TaxComponentResult {
  /** `CGST`, `SGST`, `IGST`, `UTGST`, `CESS`, `VAT`, `STATE`… */
  code: string;
  jurisdiction: string;
  rateBp: number;
  taxableMinor: number;
  taxMinor: number;
  recoverable: boolean;
  glRole: TaxGlRole;
}

export interface TaxLineResult {
  documentLineId: string;
  taxCodeId: string | null;
  taxCode: string;
  category: TaxCategory;
  /** Net after inclusive extraction, which is what revenue is credited with. */
  taxableMinor: number;
  components: TaxComponentResult[];
  totalTaxMinor: number;
}

export interface TaxResult {
  lines: TaxLineResult[];
  totalTaxMinor: number;
  /** A pack may round at document level; AR/AP posts this to `rounding`. */
  roundingAdjustmentMinor: number;
  errors: TaxProblem[];
  warnings: TaxProblem[];
}

export interface TaxProblem {
  code: string;
  message: string;
  documentLineId?: string;
}

/** One resolved code plus the rates in force on the document date. */
export interface ResolvedTaxComponent {
  component: string;
  jurisdiction: string;
  rateBp: number;
}

export interface ResolvedTaxCode {
  id: string | null;
  code: string;
  category: TaxCategory;
  components: ResolvedTaxComponent[];
}

/** Everything the engine may consult, resolved for one document date. */
export interface TaxRateTable {
  byCode: Map<string, ResolvedTaxCode>;
  byId: Map<string, ResolvedTaxCode>;
}

export interface TaxEngine {
  readonly pack: string;
  readonly status: "enabled" | "stub";
  /**
   * Pure. Never throws for a business problem — an unconfigured pack or a
   * missing registration comes back in `errors`, so a caller can show the
   * founder what to fix instead of a stack trace.
   */
  determine(context: TaxContext, rates: TaxRateTable): TaxResult;
  /** Codes this pack seeds on install, with their dated rates. */
  seedCodes(): SeedTaxCode[];
}

export interface SeedTaxCode {
  code: string;
  name: string;
  category: TaxCategory;
  description?: string;
  rates: Array<{
    component: string;
    jurisdiction: string;
    rateBp: number;
    effectiveFrom: string;
    effectiveTo?: string | null;
  }>;
}

export function emptyResult(): TaxResult {
  return { lines: [], totalTaxMinor: 0, roundingAdjustmentMinor: 0, errors: [], warnings: [] };
}

export function taxError(code: string, message: string, documentLineId?: string): TaxProblem {
  return { code, message, documentLineId };
}
