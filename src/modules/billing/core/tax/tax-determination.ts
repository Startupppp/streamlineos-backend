import {
  EU_COUNTRIES,
  JURISDICTIONS,
  SELLER_COUNTRY,
  TAX_RATES_VERSION,
  isConfiguredJurisdiction,
  type TaxTreatment,
} from "./tax-rates";

/**
 * Which tax treatment applies to a sale, and what it comes to.
 *
 * The determination and every input to it are returned together, because "why
 * was I charged this" is a question that arrives eighteen months later and
 * recomputing against current configuration answers a different question. The
 * caller stores the whole result on the invoice.
 *
 * Deliberately pure: no database, no clock, no network. A tax calculation that
 * cannot be reproduced from its inputs cannot be defended.
 */

export interface TaxSubject {
  /** ISO 3166-1 alpha-2. */
  readonly country: string;
  /** Needed only where the treatment is state-sensitive: India, and US nexus. */
  readonly state?: string | null;
  /** GSTIN, VAT number, or none. Presence is what makes a buyer a business. */
  readonly taxId?: string | null;
  /** A documented exemption the seller has accepted evidence for. */
  readonly isExempt?: boolean;
}

export interface TaxComponent {
  readonly name: string;
  readonly rateBasisPoints: number;
  readonly amountMinor: number;
}

export interface TaxDetermination {
  readonly treatment: TaxTreatment;
  readonly components: readonly TaxComponent[];
  readonly netMinor: number;
  readonly taxMinor: number;
  readonly grossMinor: number;
  /**
   * Everything the determination was made from.
   *
   * Stored verbatim on the invoice. This is the difference between an invoice
   * that reproduces and one that merely recomputes.
   */
  readonly inputs: {
    readonly sellerCountry: string;
    readonly buyerCountry: string;
    readonly buyerState: string | null;
    readonly taxId: string | null;
    readonly isExempt: boolean;
    readonly ratesVersion: string;
  };
  /** Why this treatment, in words an invoice can print. */
  readonly reason: string;
}

export class UnconfiguredJurisdictionError extends Error {
  constructor(readonly country: string) {
    super(
      `[tax] no treatment is configured for "${country}". A subscription cannot be ` +
        `created for this jurisdiction until one is: charging zero by default is a ` +
        `liability that surfaces at audit, not at checkout.`,
    );
    this.name = "UnconfiguredJurisdictionError";
  }
}

/** Format only. Whether the number is real is a question for the tax authority. */
export function isWellFormedTaxId(country: string, taxId: string | null | undefined): boolean {
  const jurisdiction = JURISDICTIONS[country.toUpperCase()];
  if (!jurisdiction?.taxIdPattern) return true;
  if (!taxId?.trim()) return false;
  return jurisdiction.taxIdPattern.test(taxId.trim().toUpperCase());
}

function treatmentFor(subject: TaxSubject, buyerCountry: string): { treatment: TaxTreatment; reason: string } {
  if (subject.isExempt)
    return { treatment: "exempt", reason: "The customer holds an accepted exemption." };

  const taxId = subject.taxId?.trim().toUpperCase() ?? "";
  const hasWellFormedTaxId = taxId !== "" && isWellFormedTaxId(buyerCountry, taxId);

  if (buyerCountry === SELLER_COUNTRY) {
    // Domestic. The place of supply decides which heads apply, and a buyer with
    // no state is treated as inter-state -- the safer of the two, because it
    // charges the same total to one head rather than under-charging two.
    const sellerState = "KA";
    const intraState = Boolean(subject.state) && subject.state?.toUpperCase() === sellerState;
    return intraState
      ? { treatment: "gst-intra-state", reason: "Supply within the seller's state." }
      : { treatment: "gst-inter-state", reason: "Supply to another state." };
  }

  if (EU_COUNTRIES.has(buyerCountry)) {
    // A registered business in the EU buying from outside it accounts for the
    // VAT itself. Without a registration number we cannot treat them as a
    // business, so the consumer rate applies.
    return hasWellFormedTaxId
      ? {
          treatment: "vat-reverse-charge",
          reason: "Reverse charge: the customer is VAT-registered and accounts for the tax.",
        }
      : { treatment: "vat", reason: "VAT at the customer's local rate." };
  }

  const jurisdiction = JURISDICTIONS[buyerCountry];
  return {
    treatment: jurisdiction!.defaultTreatment,
    reason:
      jurisdiction!.defaultTreatment === "sales-tax"
        ? "Sales tax at the configured rate for the customer's jurisdiction."
        : "Tax at the configured rate for the customer's jurisdiction.",
  };
}

/**
 * Applies the treatment to an amount.
 *
 * Each component rounds independently against the net, which is what makes
 * CGST and SGST each exactly half rather than one of them absorbing the odd
 * minor unit. Rounding the total and splitting it is how an invoice ends up
 * with heads that do not sum to the tax line.
 */
export function determineTax(netMinor: number, subject: TaxSubject): TaxDetermination {
  const buyerCountry = subject.country?.trim().toUpperCase() ?? "";

  if (!isConfiguredJurisdiction(buyerCountry))
    throw new UnconfiguredJurisdictionError(buyerCountry || "(none)");

  const jurisdiction = JURISDICTIONS[buyerCountry]!;
  const { treatment, reason } = treatmentFor(subject, buyerCountry);

  const rates = jurisdiction.components[treatment] ?? [];
  const components = rates.map((rate) => ({
    name: rate.name,
    rateBasisPoints: rate.rateBasisPoints,
    amountMinor: Math.round((netMinor * rate.rateBasisPoints) / 10_000),
  }));

  const taxMinor = components.reduce((total, component) => total + component.amountMinor, 0);

  return {
    treatment,
    components,
    netMinor,
    taxMinor,
    grossMinor: netMinor + taxMinor,
    inputs: {
      sellerCountry: SELLER_COUNTRY,
      buyerCountry,
      buyerState: subject.state?.trim().toUpperCase() ?? null,
      taxId: subject.taxId?.trim().toUpperCase() ?? null,
      isExempt: Boolean(subject.isExempt),
      ratesVersion: TAX_RATES_VERSION,
    },
    reason,
  };
}
