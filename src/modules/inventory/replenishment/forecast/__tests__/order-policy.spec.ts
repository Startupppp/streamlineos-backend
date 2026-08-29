import { applyOrderPolicy, batchProposals } from "../order-policy";

/**
 * C1 turned every figure in this file into an exact `numeric(18,4)` decimal
 * string, so the assertions compare strings. That is not ceremony: these
 * quantities land on `inv_po_lines` and the money lands on the purchase order
 * total, and `toBe(24)` would still have passed against an implementation that
 * computed 23.999999999999996 and rounded it on the way out.
 */
describe("INV-309 order policy rounding", () => {
  it("leaves an unconstrained quantity alone", () => {
    const result = applyOrderPolicy("7", { minOrderQty: null, orderMultiple: null });
    expect(result.ordered).toBe("7.0000");
    expect(result.excess).toBe("0.0000");
    expect(result.reasons).toEqual([]);
  });

  it("raises a small order to the supplier's minimum", () => {
    const result = applyOrderPolicy("7", { minOrderQty: "24", orderMultiple: null });
    expect(result.ordered).toBe("24.0000");
    expect(result.excess).toBe("17.0000");
    expect(result.reasons[0]).toMatch(/minimum order quantity/);
  });

  it("rounds up to the pack size, never down", () => {
    // Rounding a shortfall down produces an order that does not fix the
    // shortfall, which is the one outcome with no argument for it.
    const result = applyOrderPolicy("13", { minOrderQty: null, orderMultiple: "12" });
    expect(result.ordered).toBe("24.0000");
  });

  it("leaves an exact multiple exactly alone", () => {
    // The boundary. Without it, the rule above would also pass against an
    // implementation that always added a pack.
    const result = applyOrderPolicy("24", { minOrderQty: null, orderMultiple: "12" });
    expect(result.ordered).toBe("24.0000");
    expect(result.reasons).toEqual([]);
  });

  it("does not add a pack because a float divided badly", () => {
    // The reason this file is in decimals. `Math.ceil(24 / 0.1)` is 241, so a
    // float implementation orders one more pack than the supplier sells, on a
    // pack size that is entirely ordinary for anything weighed rather than
    // counted.
    const result = applyOrderPolicy("24", { minOrderQty: null, orderMultiple: "0.1" });
    expect(result.ordered).toBe("24.0000");
    expect(result.reasons).toEqual([]);
  });

  it("applies the minimum first, then the pack size", () => {
    // Order matters: 7 raised to 20 then rounded to 24 is right; rounding to 12
    // first and then checking the minimum gives 20, which is not a whole number
    // of cases and the supplier will reject it.
    const result = applyOrderPolicy("7", { minOrderQty: "20", orderMultiple: "12" });
    expect(result.ordered).toBe("24.0000");
    expect(result.reasons).toHaveLength(2);
  });

  it("reports what the policy cost in units", () => {
    // The difference between "we need 7" and "we will buy 24" is a commercial
    // decision, and it has to be visible rather than absorbed.
    const result = applyOrderPolicy("7", { minOrderQty: "24", orderMultiple: null });
    expect(result.requested).toBe("7.0000");
    expect(result.excess).toBe("17.0000");
  });

  it("ignores a nonsensical multiple rather than dividing by it", () => {
    const result = applyOrderPolicy("7", { minOrderQty: null, orderMultiple: "0" });
    expect(result.ordered).toBe("7.0000");
  });

  it("places no order for a variant that is not short", () => {
    const result = applyOrderPolicy("0", { minOrderQty: "24", orderMultiple: "12" });
    expect(result.ordered).toBe("0.0000");
    expect(result.reasons).toEqual([]);
  });
});

describe("INV-309 batching and approval", () => {
  const line = (
    vendorId: number,
    value: string,
    excess = "0",
    site: {
      warehouseId?: number | null;
      currency?: string;
      engineOrdered?: string;
      override?: { requested: string; reason: string } | null;
    } = {},
  ) => ({
    vendorId,
    vendorName: `Vendor ${vendorId}`,
    warehouseId: site.warehouseId ?? 1,
    warehouseName: `Site ${site.warehouseId ?? 1}`,
    currency: site.currency ?? "INR",
    productVariantId: vendorId * 100,
    productName: "Thing",
    requested: "10",
    ordered: "10",
    // Defaults to the engine's own answer -- ordered equals engineOrdered and
    // nothing was overridden -- but both are parameters, because a fixture that
    // pins them makes every line in the file un-overridden by construction and
    // leaves the branch they were added for untested.
    engineOrdered: site.engineOrdered ?? "10",
    override: site.override ?? null,
    unitCost: value,
    lineValue: value,
    excess,
    reasons: [],
  });

  it("puts one order per vendor, not one per SKU", () => {
    // Eleven separate orders to one supplier on one day is eleven delivery
    // fees and eleven receipts to book.
    const batches = batchProposals(
      [line(1, "100"), line(1, "50"), line(2, "30")],
      { requireApproval: false, approvalThreshold: null },
    );
    expect(batches).toHaveLength(2);
    expect(batches.find((b) => b.vendorId === 1)!.lines).toHaveLength(2);
    expect(batches.find((b) => b.vendorId === 1)!.totalValue).toBe("150.0000");
  });

  it("adds money exactly across a batch", () => {
    // 0.1 + 0.2 is the whole argument for this file being in decimals: in
    // floats the total is 0.30000000000000004, and it is compared against an
    // approval threshold.
    const batches = batchProposals(
      [line(1, "0.1"), line(1, "0.2")],
      { requireApproval: false, approvalThreshold: "0.3" },
    );
    expect(batches[0]!.totalValue).toBe("0.3000");
    expect(batches[0]!.requiresApproval).toBe(false);
  });

  it("checks the threshold against the batched total, not the line", () => {
    // A policy evaluated per line is avoided by splitting the order, which is
    // precisely what batching just stopped happening by accident.
    const batches = batchProposals(
      [line(1, "60"), line(1, "60")],
      { requireApproval: false, approvalThreshold: "100" },
    );
    expect(batches[0]!.requiresApproval).toBe(true);
    expect(batches[0]!.approvalReason).toMatch(/exceeds the approval threshold/);
  });

  it("leaves a batch under the threshold alone", () => {
    const batches = batchProposals(
      [line(1, "40")],
      { requireApproval: false, approvalThreshold: "100" },
    );
    expect(batches[0]!.requiresApproval).toBe(false);
    expect(batches[0]!.approvalReason).toBeUndefined();
  });

  it("honours a blanket approval requirement regardless of value", () => {
    const batches = batchProposals(
      [line(1, "1")],
      { requireApproval: true, approvalThreshold: "1000000" },
    );
    expect(batches[0]!.requiresApproval).toBe(true);
    expect(batches[0]!.approvalReason).toMatch(/every purchase order/);
  });

  it("totals what the order policy cost across the batch", () => {
    const batches = batchProposals(
      [line(1, "100", "17"), line(1, "50", "3")],
      { requireApproval: false, approvalThreshold: null },
    );
    expect(batches[0]!.totalExcessUnits).toBe("20.0000");
  });

  it("carries a human's override onto the batched line, beside the engine's own number", () => {
    // po-batch.service builds its inv_proposal_overrides rows from
    // `lines.filter(l => l.override !== null)`, so a batch that drops the field
    // records nothing and the audit trail for "somebody overrode the engine"
    // is silently empty. Both numbers must survive batching, distinguishable.
    const overridden = line(1, "100", "0", {
      engineOrdered: "10",
      override: { requested: "25", reason: "Supplier minimum lifted this quarter" },
    });
    const batches = batchProposals([overridden, line(1, "50")], {
      requireApproval: false,
      approvalThreshold: null,
    });

    expect(batches).toHaveLength(1);
    const carried = batches[0]!.lines.filter((l) => l.override !== null);
    expect(carried).toHaveLength(1);
    expect(carried[0]!.override).toEqual({
      requested: "25",
      reason: "Supplier minimum lifted this quarter",
    });
    // The engine's answer is kept beside the human's, not overwritten by it.
    expect(carried[0]!.engineOrdered).toBe("10");
    expect(batches[0]!.lines.filter((l) => l.override === null)).toHaveLength(1);
  });
});
