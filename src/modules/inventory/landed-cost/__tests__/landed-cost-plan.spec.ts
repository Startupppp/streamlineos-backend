import { UnprocessableEntityException } from "@nestjs/common";
import { planLandedCost } from "../lib/landed-cost-plan";

/**
 * G5 — the refusals between a landed-cost voucher's lock and its first write.
 *
 * These lived inside `LandedCostApplyService.applyInTx`, interleaved with the
 * updates that follow them, and the only thing that exercised them was
 * `landed-cost.seeded-e2e-spec` — which needs a database, a seeded tenant and a
 * posted receipt to ask "does this refuse a weighted-average variant". One of
 * them, `assertNothingLost`, was not reachable from there at all.
 *
 * Pulling the deciding half into `lib/landed-cost-plan.ts` made them answerable
 * without any of that: `planLandedCost` reads its layers through the `tx` it is
 * handed and writes nothing, so a stub that returns rows is a complete
 * environment for it. That is the point of the seam, and this is the evidence.
 *
 * Every case here fails if its guard is deleted. The last one is the floor: a
 * `planLandedCost` that threw unconditionally would satisfy all the others.
 */

interface LayerRowFixture {
  id: number;
  product_variant_id: number;
  costing_method: string;
  quantity: string;
  unit_cost: string;
  total_value: string;
  remaining_quantity: string;
  remaining_value: string;
}

function layer(over: Partial<LayerRowFixture> = {}): LayerRowFixture {
  return {
    id: 1,
    product_variant_id: 100,
    costing_method: "FIFO",
    quantity: "10.0000",
    unit_cost: "5.0000",
    total_value: "50.0000",
    remaining_quantity: "10.0000",
    remaining_value: "50.0000",
    ...over,
  };
}

/**
 * A transaction that answers the layer lock and nothing else.
 *
 * `execute` is the only member `planLandedCost` may touch — it decides and does
 * not write — so anything else being reached is itself the failure.
 */
function txReturning(rows: LayerRowFixture[]) {
  const execute = jest.fn(async (_query: unknown) => rows);
  const forbid = (what: string) =>
    jest.fn((): never => {
      throw new Error(`planLandedCost must not ${what}`);
    });
  return { execute, update: forbid("update"), insert: forbid("insert") };
}

/** The shape `planLandedCost` takes is drizzle's `tx`; the stub is a subset of it. */
function planWith(rows: LayerRowFixture[], basis: "VALUE" | "QUANTITY", charge: string) {
  const tx = txReturning(rows);
  return { tx, run: () => planLandedCost(tx as never, "org-1", 7, basis, charge) };
}

describe("G5 - planning a landed-cost apply", () => {
  it("refuses a receipt that produced no cost layers", async () => {
    // No layers means the receipt was never posted, so there is nothing to land
    // a cost onto and no honest way to invent one.
    const { run } = planWith([], "QUANTITY", "12.0000");
    await expect(run()).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(run()).rejects.toThrow(/no cost layers/);
  });

  it("refuses a weighted-average variant rather than mis-costing it quietly", async () => {
    // On weighted average the issue path draws at `inv_stock_levels.average_cost`
    // and never looks at the layer, so revaluing the layer would look entirely
    // successful, change the valuation report, and leave every later issue
    // costing at the old average — the worst of the three outcomes.
    const { run } = planWith(
      [layer({ costing_method: "WEIGHTED_AVERAGE" })],
      "QUANTITY",
      "12.0000",
    );
    await expect(run()).rejects.toThrow(/weighted-average/);
  });

  it("names how many layers forced that refusal, so the receipt can be found", async () => {
    const { run } = planWith(
      [layer({ id: 1 }), layer({ id: 2, costing_method: "WEIGHTED_AVERAGE" })],
      "QUANTITY",
      "12.0000",
    );
    await expect(run()).rejects.toThrow(/1 of 2 layers/);
  });

  it("refuses a VALUE basis against layers worth nothing, and says which basis would work", async () => {
    // There is no defensible proportion to divide by. The message names the
    // QUANTITY basis because that is the fix, and the caller cannot see the
    // layers to work it out themselves.
    const { run } = planWith(
      [layer({ total_value: "0.0000", remaining_value: "0.0000" })],
      "VALUE",
      "12.0000",
    );
    await expect(run()).rejects.toThrow(/QUANTITY basis/);
  });

  it("refuses a QUANTITY basis against layers holding no quantity", async () => {
    const { run } = planWith(
      [layer({ quantity: "0.0000", remaining_quantity: "0.0000" })],
      "QUANTITY",
      "12.0000",
    );
    await expect(run()).rejects.toThrow(/no quantity/);
  });

  it("reads the layers and writes nothing", async () => {
    const { tx, run } = planWith([layer()], "QUANTITY", "12.0000");
    await run();
    expect(tx.execute).toHaveBeenCalledTimes(1);
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("accounts for every penny of a charge it does accept", async () => {
    // The anti-vacuity floor, and `assertNothingLost`'s own claim: the plan
    // balances or it is not returned. A lost ten-thousandth does not throw on
    // its own — it leaves the general ledger out by an amount too small to
    // notice per voucher and exactly large enough to make a month-end
    // reconciliation unexplainable.
    const { run } = planWith(
      [layer({ id: 1, product_variant_id: 100 }), layer({ id: 2, product_variant_id: 101 })],
      "QUANTITY",
      "13.0000",
    );
    const plan = await run();
    expect(plan.rows).toHaveLength(2);

    const total = Number(plan.capitalisedTotal) + Number(plan.expensedTotal);
    expect(total).toBeCloseTo(13, 4);
    // Split across both layers rather than banked on the first.
    expect(plan.rows.map((r) => r.layerId)).toEqual([1, 2]);
    for (const row of plan.rows) expect(Number(row.allocated)).toBeGreaterThan(0);
  });
});
