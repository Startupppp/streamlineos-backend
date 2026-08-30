import { classifyVelocity, rankBySlot } from "../slotting-rules";
import type { PutawaySuggestion } from "../../warehouses/putaway.service";

function bin(overrides: Partial<PutawaySuggestion> & { locationId: number }): PutawaySuggestion {
  return {
    code: `BIN-${overrides.locationId}`,
    name: `Bin ${overrides.locationId}`,
    capacity: "100.0000",
    onHand: "0.0000",
    remaining: "100.0000",
    holdsVariant: false,
    fits: true,
    ...overrides,
  };
}

const NO_SLOT = { locationIds: new Set<number>(), ruleName: null };

describe("NEO-6 - putaway ranks by slot", () => {
  it("puts a gold-zone bin first, ahead of the bin that already holds the SKU", () => {
    // The work order's own acceptance: a fast-mover SKU suggests a gold-zone bin
    // first. Consolidation is the rank it has to beat, because putting a fast
    // mover beside its own stock in a back aisle is the outcome slotting exists
    // to stop.
    const ranked = rankBySlot(
      [
        bin({ locationId: 1, holdsVariant: true, remaining: "50.0000" }),
        bin({ locationId: 2, remaining: "10.0000" }),
      ],
      { locationIds: new Set([2]), ruleName: "Gold zone for class A" },
    );

    expect(ranked[0]!.locationId).toBe(2);
    expect(ranked[0]!.inSlot).toBe(true);
    expect(ranked[0]!.slotRuleName).toBe("Gold zone for class A");
    expect(ranked[1]!.locationId).toBe(1);
  });

  it("never suggests a bin the quantity does not fit in, slot or no slot", () => {
    // A suggestion the engine will refuse is worse than none: the operator has
    // walked for nothing.
    const ranked = rankBySlot(
      [
        bin({ locationId: 1, fits: false, remaining: "0.0000" }),
        bin({ locationId: 2, fits: true, remaining: "5.0000" }),
      ],
      { locationIds: new Set([1]), ruleName: "Gold zone" },
    );

    expect(ranked[0]!.locationId).toBe(2);
  });

  it("degrades to exactly the pre-slotting order when no rule matches", () => {
    // The compatibility argument, made a test: an organisation that has written
    // no rules must see no change at all.
    const ranked = rankBySlot(
      [
        bin({ locationId: 1, remaining: "10.0000" }),
        bin({ locationId: 2, holdsVariant: true, remaining: "5.0000" }),
        bin({ locationId: 3, remaining: "80.0000" }),
      ],
      NO_SLOT,
    );

    expect(ranked.map((r) => r.locationId)).toEqual([2, 3, 1]);
    expect(ranked.every((r) => !r.inSlot)).toBe(true);
  });

  it("sorts an unlimited bin as unlimited rather than as very large", () => {
    const ranked = rankBySlot(
      [bin({ locationId: 1, capacity: null, remaining: null }), bin({ locationId: 2, remaining: "5.0000" })],
      NO_SLOT,
    );
    expect(ranked[0]!.locationId).toBe(2);
  });
});

describe("NEO-6 - ABC classification", () => {
  it("splits on cumulative share of picks, not on rank position", () => {
    const classified = classifyVelocity([
      { productVariantId: 1, pickCount: 80, issuedQty: "800.0000" },
      { productVariantId: 2, pickCount: 15, issuedQty: "150.0000" },
      { productVariantId: 3, pickCount: 5, issuedQty: "50.0000" },
    ]);

    expect(classified.map((c) => [c.productVariantId, c.velocityClass])).toEqual([
      [1, "A"],
      [2, "B"],
      [3, "C"],
    ]);
  });

  it("counts visits, not units", () => {
    // A SKU picked a hundred times in ones costs a hundred journeys; one picked
    // once in hundreds costs one. Slotting is about walks.
    const classified = classifyVelocity([
      { productVariantId: 1, pickCount: 1, issuedQty: "10000.0000" },
      { productVariantId: 2, pickCount: 99, issuedQty: "99.0000" },
    ]);
    expect(classified.find((c) => c.productVariantId === 2)!.velocityClass).toBe("A");
    expect(classified.find((c) => c.productVariantId === 1)!.velocityClass).toBe("C");
  });

  it("calls everything C when nothing moved", () => {
    // An empty window is an absence of evidence. Calling it "fast" would send a
    // dead catalogue to the gold zone.
    const classified = classifyVelocity([
      { productVariantId: 1, pickCount: 0, issuedQty: "0.0000" },
      { productVariantId: 2, pickCount: 0, issuedQty: "0.0000" },
    ]);
    expect(classified.every((c) => c.velocityClass === "C")).toBe(true);
  });

  it("is stable between runs when two SKUs tie", () => {
    // A SKU that changes class every night because two counts are equal is a
    // re-slot recommendation that never converges.
    const rows = [
      { productVariantId: 9, pickCount: 10, issuedQty: "10.0000" },
      { productVariantId: 4, pickCount: 10, issuedQty: "10.0000" },
    ];
    const first = classifyVelocity(rows).map((c) => c.productVariantId);
    const second = classifyVelocity([...rows].reverse()).map((c) => c.productVariantId);
    expect(first).toEqual(second);
  });
});
