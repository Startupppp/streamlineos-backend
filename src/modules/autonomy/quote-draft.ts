/**
 * Turning a deal into a quote's line items, without a model.
 *
 * Pricing is arithmetic. A language model asked to multiply a quantity by a unit
 * price will usually be right, which is worse than being reliably wrong — the
 * failure is a customer receiving a figure nobody can reconstruct. So the money
 * is computed here and the model, where one is used at all, only writes prose
 * around it.
 */

export interface DealForQuote {
  readonly name: string;
  readonly valueMinor: number;
  readonly currency: string;
}

export interface QuoteLine {
  readonly description: string;
  readonly quantity: number;
  /** Major units, because that is what the quotes DTO takes. */
  readonly unitPrice: number;
  readonly taxRate?: number;
}

export interface QuoteDraft {
  readonly subject: string;
  readonly lineItems: readonly QuoteLine[];
  readonly validUntil: string;
}

export type DraftRefusal = { readonly ok: false; readonly reason: string };
export type DraftResult = { readonly ok: true; readonly draft: QuoteDraft } | DraftRefusal;

/** Minor units to major, as text, so no float rounding reaches the customer. */
export function toMajorUnits(minor: number): number {
  return Number((minor / 100).toFixed(2));
}

const DEFAULT_VALIDITY_DAYS = 14;

/**
 * A quote the deal actually supports, or a refusal saying why not.
 *
 * Refusing is the important half. A deal with no value would otherwise produce a
 * quote for nothing and send it, and "the system emailed my customer a zero"
 * is not a failure a confidence threshold can catch.
 */
export function draftQuoteFromDeal(
  deal: DealForQuote,
  now: Date = new Date(),
): DraftResult {
  if (!deal.name.trim()) return { ok: false, reason: "The deal has no name to quote against." };

  if (!Number.isFinite(deal.valueMinor) || deal.valueMinor <= 0)
    return { ok: false, reason: "The deal has no value, so there is nothing to quote." };

  const validUntil = new Date(now.getTime() + DEFAULT_VALIDITY_DAYS * 86_400_000);

  return {
    ok: true,
    draft: {
      subject: `Quote for ${deal.name.trim()}`,
      lineItems: [
        {
          description: deal.name.trim(),
          quantity: 1,
          unitPrice: toMajorUnits(deal.valueMinor),
        },
      ],
      validUntil: validUntil.toISOString().slice(0, 10),
    },
  };
}
