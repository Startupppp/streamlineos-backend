import { applyOrderPolicy, batchByVendor } from "../order-policy";

describe("INV-309 order policy rounding", () => {
  it("leaves an unconstrained quantity alone", () => {
    const result = applyOrderPolicy(7, { minOrderQty: null, orderMultiple: null });
    expect(result.ordered).toBe(7);
    expect(result.excess).toBe(0);
    expect(result.reasons).toEqual([]);
  });

  it("raises a small order to the supplier's minimum", () => {
    const result = applyOrderPolicy(7, { minOrderQty: 24, orderMultiple: null });
    expect(result.ordered).toBe(24);
    expect(result.excess).toBe(17);
    expect(result.reasons[0]).toMatch(/minimum order quantity/);
  });

  it("rounds up to the pack size, never down", () => {
    // Rounding a shortfall down produces an order that does not fix the
    // shortfall, which is the one outcome with no argument for it.
    const result = applyOrderPolicy(13, { minOrderQty: null, orderMultiple: 12 });
    expect(result.ordered).toBe(24);
  });

  it("leaves an exact multiple exactly alone", () => {
    // The boundary. Without it, the rule above would also pass against an
    // implementation that always added a pack.
    const result = applyOrderPolicy(24, { minOrderQty: null, orderMultiple: 12 });
    expect(result.ordered).toBe(24);
    expect(result.reasons).toEqual([]);
  });

  it("applies the minimum first, then the pack size", () => {
    // Order matters: 7 raised to 20 then rounded to 24 is right; rounding to 12
    // first and then checking the minimum gives 20, which is not a whole number
    // of cases and the supplier will reject it.
    const result = applyOrderPolicy(7, { minOrderQty: 20, orderMultiple: 12 });
    expect(result.ordered).toBe(24);
    expect(result.reasons).toHaveLength(2);
  });

  it("reports what the policy cost in units", () => {
    // The difference between "we need 7" and "we will buy 24" is a commercial
    // decision, and it has to be visible rather than absorbed.
    const result = applyOrderPolicy(7, { minOrderQty: 24, orderMultiple: null });
    expect(result.requested).toBe(7);
    expect(result.excess).toBe(17);
  });

  it("ignores a nonsensical multiple rather than dividing by it", () => {
    const result = applyOrderPolicy(7, { minOrderQty: null, orderMultiple: 0 });
    expect(result.ordered).toBe(7);
  });
});

describe("INV-309 batching and approval", () => {
  const line = (vendorId: number, value: number, excess = 0) => ({
    vendorId,
    vendorName: `Vendor ${vendorId}`,
    productVariantId: vendorId * 100,
    productName: "Thing",
    requested: 10,
    ordered: 10,
    unitCost: value / 10,
    lineValue: value,
    excess,
    reasons: [],
  });

  it("puts one order per vendor, not one per SKU", () => {
    // Eleven separate orders to one supplier on one day is eleven delivery
    // fees and eleven receipts to book.
    const batches = batchByVendor(
      [line(1, 100), line(1, 50), line(2, 30)],
      { requireApproval: false, approvalThreshold: null },
    );
    expect(batches).toHaveLength(2);
    expect(batches.find((b) => b.vendorId === 1)!.lines).toHaveLength(2);
    expect(batches.find((b) => b.vendorId === 1)!.totalValue).toBe(150);
  });

  it("checks the threshold against the batched total, not the line", () => {
    // A policy evaluated per line is avoided by splitting the order, which is
    // precisely what batching just stopped happening by accident.
    const batches = batchByVendor(
      [line(1, 60), line(1, 60)],
      { requireApproval: false, approvalThreshold: 100 },
    );
    expect(batches[0]!.requiresApproval).toBe(true);
    expect(batches[0]!.approvalReason).toMatch(/exceeds the approval threshold/);
  });

  it("leaves a batch under the threshold alone", () => {
    const batches = batchByVendor(
      [line(1, 40)],
      { requireApproval: false, approvalThreshold: 100 },
    );
    expect(batches[0]!.requiresApproval).toBe(false);
    expect(batches[0]!.approvalReason).toBeUndefined();
  });

  it("honours a blanket approval requirement regardless of value", () => {
    const batches = batchByVendor(
      [line(1, 1)],
      { requireApproval: true, approvalThreshold: 1_000_000 },
    );
    expect(batches[0]!.requiresApproval).toBe(true);
    expect(batches[0]!.approvalReason).toMatch(/every purchase order/);
  });

  it("totals what the order policy cost across the batch", () => {
    const batches = batchByVendor(
      [line(1, 100, 17), line(1, 50, 3)],
      { requireApproval: false, approvalThreshold: null },
    );
    expect(batches[0]!.totalExcessUnits).toBe(20);
  });
});
