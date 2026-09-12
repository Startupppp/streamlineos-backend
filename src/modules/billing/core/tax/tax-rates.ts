/**
 * Tax rates and treatments, as configuration.
 *
 * These change without us -- a legislature moves a rate and every invoice after
 * that date uses the new one -- so they live in a table that can be edited and
 * versioned rather than in the logic that applies them. The logic decides *which*
 * treatment applies; this decides what that treatment costs.
 *
 * **This file is not tax advice and does not attempt to be.** It encodes the
 * rates somebody who knows told us to charge, with the version they told us, so
 * an invoice can be reproduced and a wrong rate is a data correction rather than
 * a deploy.
 *
 * Rates are basis points: 18% is 1800. Integers throughout, because a rate held
 * as 0.18 and multiplied by a price is how a rounding argument starts.
 */

export type TaxTreatment =
  | "gst-intra-state"
  | "gst-inter-state"
  | "vat"
  | "vat-reverse-charge"
  | "sales-tax"
  | "zero-rated-export"
  | "exempt";

export interface TaxComponentRate {
  /** As it must appear on the invoice: "CGST", "SGST", "IGST", "VAT". */
  readonly name: string;
  readonly rateBasisPoints: number;
}

export interface JurisdictionRates {
  readonly country: string;
  /** Which treatment applies to a buyer with no tax identifier. */
  readonly defaultTreatment: TaxTreatment;
  readonly components: Readonly<Record<string, readonly TaxComponentRate[]>>;
  /** A tax identifier's expected shape, so a typo is caught at entry. */
  readonly taxIdPattern?: RegExp;
  readonly taxIdLabel?: string;
}

/**
 * Bumped whenever any rate changes.
 *
 * Stored on every invoice. Without it, reproducing a two-year-old invoice means
 * guessing which rates were in force, and the answer to "why was I charged this"
 * becomes "because that is what the code says today".
 */
export const TAX_RATES_VERSION = "2026-08-26";

/** Where we are established, which decides whether a sale is domestic or an export. */
export const SELLER_COUNTRY = "IN";

const IN_GST_RATE = 1800;

/** The EU members we price in share a shape; only the rate differs. */
function euCountry(country: string, rateBasisPoints: number): JurisdictionRates {
  return {
    country,
    defaultTreatment: "vat",
    components: {
      vat: [{ name: "VAT", rateBasisPoints }],
      // Reverse charge is zero on our invoice; the buyer accounts for it.
      "vat-reverse-charge": [{ name: "VAT (reverse charge)", rateBasisPoints: 0 }],
    },
    taxIdPattern: /^[A-Z]{2}[0-9A-Z]{2,13}$/,
    taxIdLabel: "VAT number",
  };
}

export const JURISDICTIONS: Readonly<Record<string, JurisdictionRates>> = {
  IN: {
    country: "IN",
    defaultTreatment: "gst-intra-state",
    components: {
      // Intra-state splits the same total across two heads; inter-state does not.
      // The split is not cosmetic -- they are remitted to different authorities.
      "gst-intra-state": [
        { name: "CGST", rateBasisPoints: IN_GST_RATE / 2 },
        { name: "SGST", rateBasisPoints: IN_GST_RATE / 2 },
      ],
      "gst-inter-state": [{ name: "IGST", rateBasisPoints: IN_GST_RATE }],
    },
    taxIdPattern: /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/,
    taxIdLabel: "GSTIN",
  },

  IE: euCountry("IE", 2300),
  DE: euCountry("DE", 1900),
  FR: euCountry("FR", 2000),
  NL: euCountry("NL", 2100),
  ES: euCountry("ES", 2100),
  IT: euCountry("IT", 2200),

  GB: {
    country: "GB",
    defaultTreatment: "vat",
    components: { vat: [{ name: "VAT", rateBasisPoints: 2000 }] },
    taxIdPattern: /^GB[0-9]{9}([0-9]{3})?$/,
    taxIdLabel: "VAT number",
  },

  // Sales tax is a state question and we have nexus in none of them, so the
  // configured rate is zero and the treatment says so rather than pretending the
  // sale is untaxed in principle. When nexus is registered, this is where it goes.
  US: {
    country: "US",
    defaultTreatment: "sales-tax",
    components: { "sales-tax": [{ name: "Sales tax", rateBasisPoints: 0 }] },
  },

  AE: {
    country: "AE",
    defaultTreatment: "vat",
    components: { vat: [{ name: "VAT", rateBasisPoints: 500 }] },
  },
  SG: {
    country: "SG",
    defaultTreatment: "vat",
    components: { vat: [{ name: "GST", rateBasisPoints: 900 }] },
  },
  AU: {
    country: "AU",
    defaultTreatment: "vat",
    components: { vat: [{ name: "GST", rateBasisPoints: 1000 }] },
  },
  CA: {
    country: "CA",
    defaultTreatment: "vat",
    components: { vat: [{ name: "GST", rateBasisPoints: 500 }] },
  },
};

export const EU_COUNTRIES: ReadonlySet<string> = new Set(["IE", "DE", "FR", "NL", "ES", "IT"]);

export function isConfiguredJurisdiction(country: string | null | undefined): boolean {
  return typeof country === "string" && Object.hasOwn(JURISDICTIONS, country.toUpperCase());
}
