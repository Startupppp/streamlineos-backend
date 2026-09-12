import type { PutawaySuggestion } from "../warehouses/putaway-suggestion";
import { cmpDec } from "../stock-engine/decimal";

/**
 * NEO-6 - the slotting half of a putaway suggestion, as a pure function.
 *
 * Kept out of the service because it is the part with an opinion, and an opinion
 * worth testing on its own: given a list of bins and the set the rules point at,
 * which order should an operator see them in.
 *
 * The order, and each rank is an operational preference rather than a tidy sort:
 *
 *   1. **Fits.** A suggestion the engine will refuse is worse than none - the
 *      operator has walked for nothing. Unchanged from INV-202.
 *   2. **In the slot.** A bin inside the zone the rules point at. This is the
 *      rank NEO-6 adds, and it goes above consolidation deliberately: putting a
 *      fast mover beside its own existing stock in a back aisle is exactly the
 *      outcome slotting exists to stop.
 *   3. **Holds the variant.** Consolidation, so a SKU does not scatter across a
 *      building one delivery at a time.
 *   4. **Most room first**, so the building fills evenly rather than wedging
 *      every delivery into the first bin with a gap.
 *
 * An organisation with no rules gets step 2 as a constant, and therefore exactly
 * the INV-202 order it had before. That is the compatibility argument, and it is
 * why this is a re-rank rather than a replacement.
 */
export interface SlottedSuggestion extends PutawaySuggestion {
  /** True when this bin sits inside a zone the rules point at for this SKU. */
  inSlot: boolean;
  /** The rule that put it there, for a screen that has to explain the order. */
  slotRuleName: string | null;
}

export function rankBySlot(
  suggestions: readonly PutawaySuggestion[],
  slot: { locationIds: ReadonlySet<number>; ruleName: string | null },
): SlottedSuggestion[] {
  const ranked = suggestions.map<SlottedSuggestion>((suggestion) => ({
    ...suggestion,
    inSlot: slot.locationIds.has(suggestion.locationId),
    slotRuleName: slot.locationIds.has(suggestion.locationId) ? slot.ruleName : null,
  }));

  return ranked.sort((a, b) => {
    if (a.fits !== b.fits) return a.fits ? -1 : 1;
    if (a.inSlot !== b.inSlot) return a.inSlot ? -1 : 1;
    if (a.holdsVariant !== b.holdsVariant) return a.holdsVariant ? -1 : 1;
    if (a.remaining === null && b.remaining === null) return 0;
    // Unlimited sorts as unlimited rather than as "very large", so a bin with no
    // capacity recorded does not silently outrank every measured one.
    if (a.remaining === null) return 1;
    if (b.remaining === null) return -1;
    return cmpDec(b.remaining, a.remaining);
  });
}

/**
 * ABC from a window of picks, exactly.
 *
 * The classic Pareto split on **cumulative share of picks**: the SKUs that make
 * up the first 80% of movement are A, the next 15% B, the rest C. Ranked by pick
 * *count* rather than units, because slotting is about walks: a SKU picked a
 * hundred times in ones costs a hundred journeys, and one picked once in
 * hundreds costs one.
 *
 * Ties are broken by variant id so the classification is stable between runs -
 * a SKU that changes class every night because two counts are equal is a re-slot
 * recommendation that never converges.
 */
export interface VelocityInput {
  productVariantId: number;
  pickCount: number;
  issuedQty: string;
}

export interface VelocityClassified extends VelocityInput {
  velocityClass: "A" | "B" | "C";
}

const A_SHARE = 0.8;
const B_SHARE = 0.95;

export function classifyVelocity(rows: readonly VelocityInput[]): VelocityClassified[] {
  const totalPicks = rows.reduce((sum, row) => sum + row.pickCount, 0);

  // Every SKU is C when nothing moved. Not A: an empty window is an absence of
  // evidence, and calling it "fast" would send a dead catalogue to the gold zone.
  if (totalPicks === 0) {
    return rows.map((row) => ({ ...row, velocityClass: "C" as const }));
  }

  const ordered = [...rows].sort(
    (a, b) => b.pickCount - a.pickCount || a.productVariantId - b.productVariantId,
  );

  let cumulative = 0;
  return ordered.map((row) => {
    // The share *before* this SKU decides its class, so the one that crosses the
    // 80% line is itself an A. Measuring after would push the SKU that completes
    // the A band down into B, which reads as arbitrary to anybody checking.
    const shareBefore = cumulative / totalPicks;
    cumulative += row.pickCount;
    const velocityClass = shareBefore < A_SHARE ? "A" : shareBefore < B_SHARE ? "B" : "C";
    return { ...row, velocityClass };
  });
}
