/**
 * Which provider charges a given customer.
 *
 * Ticket 01 put an interface in front of Razorpay so that adding a second
 * provider would not mean branching on the provider at every call site. This is
 * the one place that branch is allowed to exist, and it is pure so it can be
 * argued with in a test rather than in production.
 *
 * The rule is **currency**, not country. Country is what a customer tells us and
 * currency is what we actually charge, and the two disagree constantly: a
 * British company with an Indian subsidiary billed in INR should be charged
 * where INR settles, and asking which country they are in gets that wrong. It is
 * also the property that makes this checkable -- a charge row records its
 * currency, so a mis-routed charge is visible afterwards.
 */

export type ProviderKey = "razorpay" | "stripe";

/**
 * Razorpay settles INR domestically, which is the whole reason it stays.
 *
 * Its international support exists but is a worse deal and a worse experience
 * than Stripe's everywhere Stripe operates, so the split is deliberately not
 * "Razorpay unless it cannot".
 */
const RAZORPAY_CURRENCIES: ReadonlySet<string> = new Set(["INR"]);

export interface ProviderAvailability {
  readonly razorpay: boolean;
  readonly stripe: boolean;
}

export type Selection =
  | { readonly ok: true; readonly provider: ProviderKey; readonly isPreferred: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * Picks a provider, and says when it could not.
 *
 * Returns a result rather than throwing because "we cannot charge this currency
 * on this deployment" is a configuration answer a caller may want to render, not
 * an exception -- and because the fallback case needs to be *reported*: charging
 * a euro customer through the wrong provider silently is how the currency
 * problem happened the first time.
 */
export function selectProvider(
  currency: string,
  available: ProviderAvailability,
): Selection {
  const normalised = currency.trim().toUpperCase();
  if (!normalised) return { ok: false, reason: "No currency was given." };

  const preferred: ProviderKey = RAZORPAY_CURRENCIES.has(normalised) ? "razorpay" : "stripe";

  if (available[preferred]) return { ok: true, provider: preferred, isPreferred: true };

  /**
   * The other one, but never silently.
   *
   * A deployment with only Razorpay configured can still take a euro payment --
   * Razorpay does support it -- and that is better than refusing the sale. What
   * is not acceptable is doing it without the caller knowing, because the
   * customer's statement will show a currency conversion nobody warned them
   * about. `isPreferred: false` is how the caller finds out.
   */
  const fallback: ProviderKey = preferred === "razorpay" ? "stripe" : "razorpay";
  if (available[fallback]) return { ok: true, provider: fallback, isPreferred: false };

  return {
    ok: false,
    reason: `No payment provider is configured that can charge ${normalised}.`,
  };
}
