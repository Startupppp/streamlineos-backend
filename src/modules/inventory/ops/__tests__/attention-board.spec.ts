import { buildAttentionItems, type AttentionItem } from "../lib/attention-board";
import type { AttentionCounts } from "../lib/attention-probes";

/**
 * B2 — the Needs Attention board's own rule, which nothing asserted until the
 * board was separable from the database.
 *
 * `runAttentionProbes` settles eleven independent queries and reports `-1`
 * wherever one failed. The board then drops that card rather than rendering it
 * as zero, and the difference is the whole point: "we looked and there is
 * nothing" and "we do not know" are opposite claims about a warehouse, and a
 * dashboard that renders the second as the first tells an operator their
 * stockouts are handled because a query timed out.
 *
 * This was written after checking it was needed: deleting the `count <= 0`
 * guard from `card` left all 271 tests in `modules/inventory/ops`,
 * `inv-ops-isolation*` and `modules/inventory/ai` passing. Every case below
 * fails against that mutation except the mapping one, which fails instead
 * against a shuffled count-to-card assignment — the hazard that exists because
 * the probes and the copy now live in different files.
 */

/** Every probe reporting nothing to do. Cases below raise one field at a time. */
function quiet(): AttentionCounts {
  return {
    outOfStock: 0,
    lowStock: 0,
    damaged: 0,
    quarantined: 0,
    transfersDelayed: 0,
    purchaseOrdersOpen: 0,
    reservationsExpiring: 0,
    reservationsExpired: 0,
    negativeStock: 0,
    overCommitted: 0,
    projectsAtRisk: 0,
  };
}

function keysOf(items: AttentionItem[]): string[] {
  return items.map((item) => item.key);
}

/** Each card, and the single count that must be the one to raise it. */
const MAPPING: ReadonlyArray<readonly [keyof AttentionCounts, string]> = [
  ["outOfStock", "out-of-stock"],
  ["lowStock", "low-stock"],
  ["damaged", "damaged-stock"],
  ["quarantined", "quarantined-stock"],
  ["transfersDelayed", "transfers-delayed"],
  ["purchaseOrdersOpen", "purchase-orders-open"],
  ["reservationsExpiring", "reservations-expiring"],
  ["reservationsExpired", "reservations-expired"],
  ["negativeStock", "negative-stock"],
  ["overCommitted", "over-committed"],
  ["projectsAtRisk", "projects-at-risk"],
];

describe("B2 - the Needs Attention board", () => {
  it("renders a card per probe when every one of them has something to say", () => {
    // The anti-vacuity floor. Without it, a `buildAttentionItems` that returned
    // `[]` unconditionally would satisfy every "renders no card" case below.
    const items = buildAttentionItems({
      outOfStock: 1,
      lowStock: 2,
      damaged: 3,
      quarantined: 4,
      transfersDelayed: 5,
      purchaseOrdersOpen: 6,
      reservationsExpiring: 7,
      reservationsExpired: 8,
      negativeStock: 9,
      overCommitted: 10,
      projectsAtRisk: 11,
    });
    expect(items).toHaveLength(MAPPING.length);
    expect(new Set(keysOf(items)).size).toBe(MAPPING.length);
  });

  it("drops a failed probe rather than reporting it as nothing to do", () => {
    // `-1` is what `runAttentionProbes` reports for a rejected query. A board
    // that rendered it would claim a count of -1 items, and a board that
    // clamped it to 0 would claim the warehouse is clear.
    const items = buildAttentionItems({ ...quiet(), outOfStock: -1 });
    expect(keysOf(items)).not.toContain("out-of-stock");
    expect(items).toEqual([]);
  });

  it("never renders a negative count, whichever probe failed", () => {
    for (const [field] of MAPPING) {
      const counts = quiet();
      counts[field] = -1;
      const items = buildAttentionItems(counts);
      expect(items).toEqual([]);
    }
  });

  it("raises no card for a probe that genuinely found nothing", () => {
    expect(buildAttentionItems(quiet())).toEqual([]);
  });

  it("puts each count on its own card and no other", () => {
    // The reason `runAttentionProbes` returns a named record rather than the
    // positional array its probes settle into: the counts and the copy live in
    // different files now, and a swapped pair would put the stockout number on
    // the quarantine card with nothing complaining.
    for (const [field, key] of MAPPING) {
      const counts = quiet();
      counts[field] = 7;
      const items = buildAttentionItems(counts);
      expect(keysOf(items)).toEqual([key]);
      expect(items[0]?.count).toBe(7);
    }
  });

  it("orders by severity first, then by how much of it there is", () => {
    const items = buildAttentionItems({
      ...quiet(),
      quarantined: 99, // info, and the largest count on the board
      lowStock: 1, // warning
      damaged: 2, // warning, more of it than lowStock
      outOfStock: 1, // critical
    });
    expect(keysOf(items)).toEqual([
      "out-of-stock",
      "damaged-stock",
      "low-stock",
      "quarantined-stock",
    ]);
  });

  it("carries a deep link and a stable key on every card it renders", () => {
    // A number an operator cannot act on is decoration; the href is the action.
    const items = buildAttentionItems({ ...quiet(), outOfStock: 3, transfersDelayed: 4 });
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.key).not.toBe("");
      expect(item.href.startsWith("/inventory/")).toBe(true);
    }
  });
});
