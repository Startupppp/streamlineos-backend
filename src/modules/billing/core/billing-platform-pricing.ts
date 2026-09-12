import type { BillingCycle, Plan } from "./dto/billing.schemas";
import {
  ANNUAL_DISCOUNT_PCT,
  PLATFORM_PRICE_CURRENCY,
} from "./plan-entitlements.constants";
import { annualPrice, currencyForCountry, priceFor } from "./plan-pricing";
import { determineTax } from "./tax/tax-determination";
import type { VersionedCatalogService } from "./versioned-catalog.service";

/**
 * Where the buyer bills from.
 *
 * Resolved by `BillingService` from the organisation's billing profile and passed
 * down, rather than read twice: the same two facts decide the currency they are
 * quoted and the tax treatment applied to it, and reading them separately is how
 * those two answers drift apart.
 */
export interface PlatformBuyer {
  readonly country?: string | null;
  readonly state?: string | null;
  readonly taxId?: string | null;
  readonly isExempt?: boolean;
}

export interface BillablePrice {
  /** Integer minor units of `currency`, before tax and before any coupon. */
  readonly amount: number;
  readonly currency: string;
}

/**
 * What this organisation is charged, as an amount AND the currency denominating it.
 *
 * Both halves come from ONE source and are never mixed: the platform catalog row if
 * the plan has one, otherwise the dated per-currency list chosen by where the buyer
 * bills from. They used to disagree — the amount from the INR-paise list, the
 * currency from `accounting_settings.base_currency` — which charged a USD-books
 * tenant $999.00 for a ₹999.00 plan and then recorded 99900 "paise" as USD.
 *
 * The tenant's base currency is deliberately absent: it is what the tenant keeps its
 * own books in and has no bearing on what this vendor bills. Refusing checkout on a
 * mismatch would be wrong for the same reason — a US company may legitimately pay an
 * INR invoice.
 */
export async function billablePrice(
  catalog: VersionedCatalogService,
  plan: Plan,
  billingCycle: BillingCycle,
  country?: string | null,
): Promise<BillablePrice> {
  const catalogPrice = await catalog.getActivePriceForPlanTier(plan);
  if (catalogPrice) {
    // MINOR UNITS of the catalog row's own currency. A dated catalog price is a
    // deliberate override of the list below, and overrides both halves together.
    return {
      amount: billingCycle === "annual"
        ? Math.round(catalogPrice.amountMinor * 12 * (1 - ANNUAL_DISCOUNT_PCT))
        : catalogPrice.amountMinor,
      currency: catalogPrice.currency,
    };
  }

  /*
    `PLAN_PRICES_PAISE` is the INR column of this same list, so a buyer who has
    named no country still pays exactly what they paid before — INR, the currency
    they are already billed in, rather than the pricing page's stranger-fallback.
  */
  const currency = currencyForCountry(country, PLATFORM_PRICE_CURRENCY);
  const monthly = priceFor(plan, currency);
  const priced = billingCycle === "annual" ? annualPrice(monthly, ANNUAL_DISCOUNT_PCT) : monthly;
  return { amount: priced.amountMinor, currency: priced.currency };
}

/**
 * The tax on a net amount, from the buyer's own jurisdiction.
 *
 * Shared because both halves of the sale need the identical determination:
 * `createOrder` charges the gross, `verifyAndActivate` records it. An unconfigured
 * jurisdiction throws, which is the right failure — charging a number we cannot
 * defend is worse than refusing to charge. The seller is established in India, so a
 * buyer who has told us nothing is treated as domestic rather than as untaxed.
 */
export function taxFor(netMinor: number, buyer: PlatformBuyer) {
  return determineTax(netMinor, {
    country: buyer.country ?? "IN",
    state: buyer.state,
    taxId: buyer.taxId,
    isExempt: buyer.isExempt ?? false,
  });
}
