import type { PaidPlan } from "./plan-entitlements.constants";

/**
 * What each plan costs, per currency, stated rather than converted.
 *
 * A converted price moves with the exchange rate, which means the same plan
 * costs a different number every morning and an invoice cannot be reproduced
 * eighteen months later when somebody asks why they were charged it. These are
 * local prices: what the plan costs in that market, chosen once and changed
 * deliberately.
 *
 * They are deliberately not proportional to each other. ₹999 is not $12 at any
 * exchange rate; it is what STARTER costs in India, and $12 is what it costs in
 * the United States.
 *
 * Amounts are integer minor units throughout -- paise, cents, pence -- per the
 * platform rule. Adding a currency is a data change here plus a payment provider
 * that can charge it.
 */

export const SUPPORTED_CURRENCIES = ["INR", "USD", "EUR", "GBP"] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

/**
 * The currency quoted when a prospect's own is not one we price in.
 *
 * Stated, never silent. A prospect in Norway is shown a dollar price and told it
 * is dollars -- being quoted a number in an unnamed currency is how somebody
 * discovers at checkout that they are paying rupees.
 */
export const FALLBACK_CURRENCY: SupportedCurrency = "USD";

type PriceTable = Readonly<Record<SupportedCurrency, Readonly<Record<PaidPlan, number>>>>;

interface DatedPrices {
  /**
   * Inclusive, ISO 8601 date. The prices below are what a plan costs from this
   * morning until the next entry's date.
   */
  readonly effectiveFrom: string;
  readonly prices: PriceTable;
}

/**
 * What each plan has cost, in order, oldest first.
 *
 * A dated series rather than one table, and that is the whole of ticket 03's
 * fourth line: "a price change is dated, so an existing subscription reproduces
 * the price in force when it was agreed". With a single table, editing a number
 * silently restates what every existing customer agreed to — the invoice from
 * eighteen months ago reprices itself, and nobody can say what was actually
 * charged or why. It is the same failure a converted price has, arriving from
 * the other direction: there, the number moves with the exchange rate; here, it
 * moves with whoever last edited the constant.
 *
 * **Raising a price is appending an entry, never editing one.** An entry that
 * has been agreed against is history and history does not get a new number. The
 * spec asserts the series only ever grows at the end and that earlier entries
 * are byte-identical to what they were, so an edit fails the build rather than
 * quietly repricing the past.
 *
 * The first entry is dated at the platform's launch rather than at the date this
 * dating was introduced: these ARE the prices every existing subscription
 * agreed to, so backdating states the truth. Dating it today would claim we do
 * not know what anyone agreed before today, which is false and would make every
 * existing subscription unreproducible.
 */
const PRICE_HISTORY: readonly DatedPrices[] = [
  {
    effectiveFrom: "2000-01-01",
    prices: {
      // India is priced for its market, not discounted from the dollar price;
      // the ratio between these columns is nothing like any exchange rate, which
      // is the point. A test asserts that, so a later "tidy-up" cannot quietly
      // make them conversions again.
      INR: { STARTER: 99_900, PROFESSIONAL: 249_900, ENTERPRISE: 499_900 },
      USD: { STARTER: 1_900, PROFESSIONAL: 4_900, ENTERPRISE: 9_900 },
      EUR: { STARTER: 1_900, PROFESSIONAL: 4_500, ENTERPRISE: 8_900 },
      GBP: { STARTER: 1_500, PROFESSIONAL: 3_900, ENTERPRISE: 7_900 },
    },
  },
];

/**
 * The prices in force on a date.
 *
 * Walks from the end so the newest applicable entry wins. A date before the
 * first entry gets the first entry rather than throwing: the only way to be
 * asked about such a date is a clock skew or a backfilled record, and answering
 * with the oldest stated price is both defensible and reproducible, where
 * throwing would take down a billing read for a timestamp nobody can fix.
 */
function pricesAsOf(asOf: Date): DatedPrices {
  const day = asOf.toISOString().slice(0, 10);
  for (let i = PRICE_HISTORY.length - 1; i >= 0; i -= 1) {
    const entry = PRICE_HISTORY[i]!;
    if (entry.effectiveFrom <= day) return entry;
  }
  return PRICE_HISTORY[0]!;
}

/** The date whose prices a given quote reproduces. Stored on a subscription. */
export function priceEffectiveFrom(asOf: Date = new Date()): string {
  return pricesAsOf(asOf).effectiveFrom;
}

/** Exported for the spec that pins the series append-only. */
export const PRICE_HISTORY_FOR_TESTS = PRICE_HISTORY;

export interface PlanPrice {
  readonly plan: PaidPlan;
  /** Integer minor units in `currency`. */
  readonly amountMinor: number;
  readonly currency: SupportedCurrency;
  /**
   * Whether this is the currency that was asked for.
   *
   * False means a fallback was used, and the caller must say so rather than
   * presenting the amount as though it were local.
   */
  readonly isRequestedCurrency: boolean;
}

/**
 * What we quote and charge a customer in, from the country they bill from.
 *
 * Deliberately its own list, and NOT the residency sets in
 * `common/region/region-placement.ts`. Those decide where data lives; this
 * decides what somebody pays in, and the two answer to different authorities —
 * Norway is in the EEA for residency and is not in the euro. Sharing one list
 * would mean a currency change moved somebody's data, or a data-residency change
 * silently re-priced them. `region-placement.ts` makes the same argument from
 * the other side, and `common/` may not import from `modules/` in any case.
 *
 * A country that maps to nothing gets `FALLBACK_CURRENCY`, stated rather than
 * assumed — see the note there.
 */
const EUROZONE: ReadonlySet<string> = new Set([
  "IE", "DE", "FR", "NL", "ES", "IT", "BE", "AT", "PT", "FI", "GR", "SK", "SI", "LT", "LV", "EE",
  "LU", "CY", "MT", "HR",
]);

export function currencyForCountry(
  country: string | null | undefined,
  /**
   * What an unknown country means, which differs by caller and so is not
   * defaulted here.
   *
   * A pricing page is talking to a stranger, and `FALLBACK_CURRENCY` (USD) is
   * the honest guess to show them. A charge is talking to an existing customer,
   * and the honest answer there is the currency they are already billed in —
   * INR, since that is where the platform is established. Silently applying the
   * stranger's fallback to a charge would re-denominate every tenant who has
   * not filled in a billing profile, none of whom asked to be.
   */
  whenUnknown: SupportedCurrency,
): SupportedCurrency {
  if (!country) return whenUnknown;
  const code = country.trim().toUpperCase();
  if (code === "IN") return "INR";
  if (code === "GB") return "GBP";
  if (code === "US") return "USD";
  if (EUROZONE.has(code)) return "EUR";
  return FALLBACK_CURRENCY;
}

export function isSupportedCurrency(value: string | null | undefined): value is SupportedCurrency {
  return (
    typeof value === "string" &&
    (SUPPORTED_CURRENCIES as readonly string[]).includes(value.trim().toUpperCase())
  );
}

/** Normalises to a currency we price in, saying whether it had to fall back. */
export function resolveCurrency(requested: string | null | undefined): {
  currency: SupportedCurrency;
  isRequestedCurrency: boolean;
} {
  const code = (requested ?? "").trim().toUpperCase();
  if (isSupportedCurrency(code))
    return { currency: code as SupportedCurrency, isRequestedCurrency: true };
  return { currency: FALLBACK_CURRENCY, isRequestedCurrency: false };
}

/**
 * The price of a plan in a currency.
 *
 * Never converts. An unpriced currency falls back to `FALLBACK_CURRENCY` and the
 * result says so, so a caller that renders the amount without the currency is a
 * bug the type can point at rather than a number nobody questions.
 */
export function priceFor(
  plan: PaidPlan,
  requested: string | null | undefined,
  /**
   * Which day's prices to quote. Defaults to today, so every existing caller
   * keeps the behaviour it had; a subscription renewing against the price it
   * agreed passes its own `priceEffectiveFrom` instead.
   */
  asOf: Date = new Date(),
): PlanPrice {
  const { currency, isRequestedCurrency } = resolveCurrency(requested);
  const table = pricesAsOf(asOf).prices;
  return { plan, amountMinor: table[currency][plan], currency, isRequestedCurrency };
}

/** Every plan in one currency, for a pricing page. */
export function priceList(
  requested: string | null | undefined,
  asOf: Date = new Date(),
): PlanPrice[] {
  const plans: PaidPlan[] = ["STARTER", "PROFESSIONAL", "ENTERPRISE"];
  return plans.map((plan) => priceFor(plan, requested, asOf));
}

/**
 * The annual charge, discounted, rounded once.
 *
 * Rounding once at the end rather than per month is the difference between a
 * yearly total that reconciles against twelve monthly ones and one that is off
 * by a few minor units for reasons nobody can reconstruct.
 */
export function annualPrice(monthly: PlanPrice, discountFraction: number): PlanPrice {
  const full = monthly.amountMinor * 12;
  return { ...monthly, amountMinor: Math.round(full * (1 - discountFraction)) };
}
