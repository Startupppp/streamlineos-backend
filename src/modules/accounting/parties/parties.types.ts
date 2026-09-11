import type { TaxRegime } from "../../../db/schema";

/**
 * The party master's response shapes. `parties.service.ts` re-exports every
 * one, so callers keep importing them from the service.
 */

/** A pointer back at the record that owns this identity elsewhere. */
export interface ExternalRef {
  system: string;
  id: string;
}

export interface PartySummary {
  id: string;
  bookId: string;
  role: "customer" | "vendor" | "both";
  displayName: string;
  legalName: string | null;
  email: string | null;
  phone: string | null;
  countryCode: string;
  defaultCurrency: string;
  billingRegion: string | null;
  billingCountryCode: string | null;
  paymentTermsDays: number;
  isActive: boolean;
}

export interface PartyDetail extends PartySummary {
  billingLine1: string | null;
  billingLine2: string | null;
  billingCity: string | null;
  billingPostalCode: string | null;
  shippingLine1: string | null;
  shippingCity: string | null;
  shippingRegion: string | null;
  shippingPostalCode: string | null;
  shippingCountryCode: string | null;
  defaultIncomeAccountId: string | null;
  defaultExpenseAccountId: string | null;
  withholdingCode: string | null;
  notes: string | null;
  externalRefs: ExternalRef[];
  taxRegistrations: PartyTaxRegistration[];
}

export interface PartyTaxRegistration {
  id: string;
  regime: TaxRegime;
  number: string;
  region: string | null;
  countryCode: string;
  isPrimary: boolean;
  validFrom: string | null;
  validTo: string | null;
}

export interface PartyPage {
  items: PartySummary[];
  page: number;
  pageSize: number;
  total: number;
}
