import { availableQty, AVAILABLE_QTY_TERMS } from "../../stock-engine/decimal";

/**
 * A1. This suite used to define its own `computeAvailable` and test that — a
 * seventh copy of the formula, verifying a reimplementation rather than the
 * function the application calls. It passed happily while the real availability
 * ignored `outgoing_qty` everywhere it was used.
 *
 * It now tests `availableQty` itself.
 */
const level = (
  onHand: string,
  committed = "0",
  blocked = "0",
  qualityHold = "0",
  outgoing = "0",
) => ({
  on_hand: onHand,
  committed,
  blocked_qty: blocked,
  quality_hold_qty: qualityHold,
  outgoing_qty: outgoing,
});

describe("ATP availability math", () => {
  it("subtracts every hold from on hand", () => {
    expect(availableQty(level("100", "10", "5", "3"))).toBe("82.0000");
  });

  it("subtracts picked-but-unshipped stock", () => {
    // The term every copy of this formula omitted. Goods on the packing bench
    // are physically present and already spoken for; counting them as
    // available promises them to a second customer.
    expect(availableQty(level("100", "0", "0", "0", "40"))).toBe("60.0000");
  });

  it("counts committed and outgoing as separate quantities", () => {
    // They are disjoint by construction -- picking moves a quantity from one to
    // the other -- so both are subtracted and neither double-counts.
    expect(availableQty(level("100", "10", "0", "0", "20"))).toBe("70.0000");
  });

  it("names all four subtracted terms, so a new one cannot be added silently", () => {
    // If somebody adds a fifth bucket to the schema, this fails until they
    // decide whether it belongs in availability.
    expect([...AVAILABLE_QTY_TERMS]).toEqual([
      "committed",
      "blocked_qty",
      "quality_hold_qty",
      "outgoing_qty",
    ]);
  });

  it("returns zero when everything is spoken for", () => {
    expect(availableQty(level("50", "20", "10", "10", "10"))).toBe("0.0000");
  });

  it("can go negative when oversold", () => {
    expect(availableQty(level("10", "20"))).toBe("-10.0000");
  });

  it("treats a null bucket as zero rather than as NaN", () => {
    // Every one of these columns is nullable, and NaN propagates into a reorder
    // quantity as a purchase order for nothing.
    expect(
      availableQty({
        on_hand: "10",
        committed: "0",
        blocked_qty: null,
        quality_hold_qty: null,
        outgoing_qty: null,
      }),
    ).toBe("10.0000");
  });

  it("is exact at four decimal places", () => {
    // Float arithmetic on these values is the defect this module has had to fix
    // four separate times.
    expect(availableQty(level("0.3", "0.1", "0.1", "0.1"))).toBe("0.0000");
  });
});

describe("forecasted position", () => {
  // Deliberately not availability: incoming goods are not in the building, and
  // a forecast is a different question from what can be promised today.
  const forecasted = (onHand: number, incoming: number, outgoing: number) =>
    onHand + incoming - outgoing;

  it("adds incoming and subtracts open demand", () => {
    expect(forecasted(100, 50, 30)).toBe(120);
  });
});
