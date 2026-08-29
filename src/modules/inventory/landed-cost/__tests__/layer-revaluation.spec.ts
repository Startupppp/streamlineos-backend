import { planRevaluation, type LayerSnapshot } from "../lib/layer-revaluation";

/**
 * G5 — what applying a voucher does to the layers, worked out by hand.
 *
 * The fixture is a two-line goods receipt, which is the shape the unit's "done
 * when" names:
 *
 *   layer A   100 units at 4.00   =   400.00
 *   layer B    50 units at 12.00  =   600.00
 *                                 ---------
 *   merchandise                      1000.00
 *
 * Every expected figure below is a literal worked out from those numbers on
 * paper. Nothing in this file recomputes the implementation's own expression.
 */
const layer = (over: Partial<LayerSnapshot> & Pick<LayerSnapshot, "id">): LayerSnapshot => ({
  productVariantId: over.id,
  costingMethod: "FIFO",
  quantity: "0.0000",
  unitCost: "0.0000",
  totalValue: "0.0000",
  remainingQuantity: "0.0000",
  remainingValue: "0.0000",
  ...over,
});

const UNTOUCHED_A = layer({
  id: 1,
  quantity: "100.0000",
  unitCost: "4.0000",
  totalValue: "400.0000",
  remainingQuantity: "100.0000",
  remainingValue: "400.0000",
});

const UNTOUCHED_B = layer({
  id: 2,
  productVariantId: 2,
  quantity: "50.0000",
  unitCost: "12.0000",
  totalValue: "600.0000",
  remainingQuantity: "50.0000",
  remainingValue: "600.0000",
});

describe("G5 — landed cost reaching the cost layers", () => {
  describe("freight that arrives with the goods", () => {
    it("puts every penny into the layers, and the layers then sum to merchandise plus freight", () => {
      // 100.00 of freight on a 1000.00 delivery, by value: 40.00 to the 400.00
      // layer and 60.00 to the 600.00 layer.
      //
      //   A   440.00 over 100 units  =  4.40 each
      //   B   660.00 over  50 units  = 13.20 each
      //   layers now hold 440.00 + 660.00 = 1100.00 = 1000.00 + 100.00
      const plan = planRevaluation("100.0000", "VALUE", [UNTOUCHED_A, UNTOUCHED_B]);

      expect(plan.capitalisedTotal).toBe("100.0000");
      expect(plan.expensedTotal).toBe("0.0000");

      const [a, b] = plan.rows;
      expect(a).toMatchObject({
        layerId: 1,
        allocated: "40.0000",
        capitalised: "40.0000",
        expensed: "0.0000",
        unitCostBefore: "4.0000",
        unitCostAfter: "4.4000",
        remainingValueAfter: "440.0000",
        totalValueAfter: "440.0000",
        writesLayer: true,
      });
      expect(b).toMatchObject({
        layerId: 2,
        allocated: "60.0000",
        capitalised: "60.0000",
        expensed: "0.0000",
        unitCostBefore: "12.0000",
        unitCostAfter: "13.2000",
        remainingValueAfter: "660.0000",
        totalValueAfter: "660.0000",
        writesLayer: true,
      });
    });

    it("allocates by quantity when the voucher says so, which is a different answer", () => {
      // The same 100.00, spread by units instead of value: 150 units in all, so
      // 100 units take two thirds and 50 take one third. Exact shares are
      // 66.666666… and 33.333333…; floored they are 66.6666 and 33.3333, and the
      // odd ten-thousandth goes to the larger shortfall, which is layer A.
      //
      //   A   400.00 + 66.6667 = 466.6667 over 100 units = 4.666667 each,
      //       floored to 4.6666 -> 466.66 held, so 0.0067 cannot be carried
      //       at the rate and is expensed;
      //   B   600.00 + 33.3333 = 633.3333 over 50 units = 12.666666 each,
      //       floored to 12.6666 -> 633.33 held, 0.0033 expensed.
      const plan = planRevaluation("100.0000", "QUANTITY", [UNTOUCHED_A, UNTOUCHED_B]);

      expect(plan.rows[0]).toMatchObject({
        allocated: "66.6667",
        unitCostAfter: "4.6666",
        remainingValueAfter: "466.6600",
        capitalised: "66.6600",
        expensed: "0.0067",
      });
      expect(plan.rows[1]).toMatchObject({
        allocated: "33.3333",
        unitCostAfter: "12.6666",
        remainingValueAfter: "633.3300",
        capitalised: "33.3300",
        expensed: "0.0033",
      });
      expect(plan.capitalisedTotal).toBe("99.9900");
      expect(plan.expensedTotal).toBe("0.0100");
    });
  });

  describe("freight that arrives after the goods have started moving", () => {
    it("capitalises onto what is left and expenses the share belonging to what has gone", () => {
      // Same delivery, but 60 of layer A's 100 units were issued before the
      // carrier invoiced. The allocation is still by the layers' original value —
      // 40.00 to A, 60.00 to B — because that is what the freight was charged on.
      //
      //   A   40 of 100 units left, so 40% of its 40.00 (= 16.00) can still reach
      //       stock and 24.00 cannot. 160.00 + 16.00 = 176.00 over 40 units =
      //       4.40 each, exactly. The 24.00 is a cost of the period the invoice
      //       landed in, because the sale of those 60 units is already on the
      //       books at 4.00 and the ledger is append-only.
      //   B   untouched, so all 60.00 capitalises as before.
      const partlyIssuedA = layer({
        id: 1,
        quantity: "100.0000",
        unitCost: "4.0000",
        totalValue: "400.0000",
        remainingQuantity: "40.0000",
        remainingValue: "160.0000",
      });

      const plan = planRevaluation("100.0000", "VALUE", [partlyIssuedA, UNTOUCHED_B]);

      expect(plan.rows[0]).toMatchObject({
        allocated: "40.0000",
        capitalised: "16.0000",
        expensed: "24.0000",
        unitCostBefore: "4.0000",
        unitCostAfter: "4.4000",
        remainingValueAfter: "176.0000",
        totalValueAfter: "416.0000",
        writesLayer: true,
      });
      expect(plan.rows[1]).toMatchObject({ capitalised: "60.0000", expensed: "0.0000" });
      expect(plan.capitalisedTotal).toBe("76.0000");
      expect(plan.expensedTotal).toBe("24.0000");
    });

    it("expenses the whole allocation for a layer that has been fully issued", () => {
      const emptied = layer({
        id: 1,
        quantity: "100.0000",
        unitCost: "4.0000",
        totalValue: "400.0000",
        remainingQuantity: "0.0000",
        remainingValue: "0.0000",
      });

      const plan = planRevaluation("100.0000", "VALUE", [emptied, UNTOUCHED_B]);

      expect(plan.rows[0]).toMatchObject({
        allocated: "40.0000",
        capitalised: "0.0000",
        expensed: "40.0000",
        unitCostAfter: "4.0000",
        writesLayer: false,
      });
      expect(plan.capitalisedTotal).toBe("60.0000");
      expect(plan.expensedTotal).toBe("40.0000");
    });
  });

  describe("what the rate cannot carry", () => {
    it("floors the rate and expenses the sub-rate remainder", () => {
      // One layer of 3 units at 10.00, and 10.00 of freight on it. Ten over three
      // is 3.333333… per unit, which `unit_cost` cannot hold: 13.3333 is the
      // largest rate it can express, and 3 x 13.3333 is 39.9999. So 9.9999
      // reaches the layer and the last ten-thousandth is expensed.
      //
      // Rounding up instead would put 40.0002 into inventory against a 40.00
      // invoice; carrying the difference in `remaining_value` while the rate
      // stayed lower would leave a gap nothing ever clears, because an issue
      // costs at the rate.
      const plan = planRevaluation(
        "10.0000",
        "VALUE",
        [
          layer({
            id: 5,
            quantity: "3.0000",
            unitCost: "10.0000",
            totalValue: "30.0000",
            remainingQuantity: "3.0000",
            remainingValue: "30.0000",
          }),
        ],
      );

      expect(plan.rows[0]).toMatchObject({
        allocated: "10.0000",
        capitalised: "9.9999",
        expensed: "0.0001",
        unitCostAfter: "13.3333",
        remainingValueAfter: "39.9999",
        totalValueAfter: "39.9999",
      });
      expect(plan.capitalisedTotal).toBe("9.9999");
      expect(plan.expensedTotal).toBe("0.0001");
    });

    it("leaves a layer alone when the allocation is smaller than one ten-thousandth per unit", () => {
      // 0.0001 of duty across a layer of 100 units is 0.000001 each. The rate
      // cannot move, so nothing is written and the whole ten-thousandth is
      // expensed rather than silently vanishing.
      const plan = planRevaluation("0.0001", "VALUE", [UNTOUCHED_A]);

      expect(plan.rows[0]).toMatchObject({
        allocated: "0.0001",
        capitalised: "0.0000",
        expensed: "0.0001",
        unitCostAfter: "4.0000",
        writesLayer: false,
      });
      expect(plan.expensedTotal).toBe("0.0001");
    });
  });

  describe("standard costing", () => {
    it("capitalises nothing, because the standard is the cost", () => {
      // Landed cost on a standard-costed SKU is a purchase price variance by
      // definition. Pushing it into the layer would make the standard not the
      // standard.
      const plan = planRevaluation("100.0000", "VALUE", [
        layer({
          id: 9,
          costingMethod: "STANDARD",
          quantity: "100.0000",
          unitCost: "4.0000",
          totalValue: "400.0000",
          remainingQuantity: "100.0000",
          remainingValue: "400.0000",
        }),
      ]);

      expect(plan.rows[0]).toMatchObject({
        allocated: "100.0000",
        capitalised: "0.0000",
        expensed: "100.0000",
        unitCostBefore: "4.0000",
        unitCostAfter: "4.0000",
        writesLayer: false,
      });
      expect(plan.capitalisedTotal).toBe("0.0000");
      expect(plan.expensedTotal).toBe("100.0000");
    });
  });

  it("never loses anything: capitalised plus expensed is the charge, in every case above", () => {
    // The identity the service asserts before it writes, and the migration's
    // CHECK enforces per row. Stated once here across the whole fixture set so a
    // future case cannot be added without it holding.
    const cases: Array<[string, LayerSnapshot[]]> = [
      ["100.0000", [UNTOUCHED_A, UNTOUCHED_B]],
      ["33.3300", [UNTOUCHED_A, UNTOUCHED_B]],
      ["0.0001", [UNTOUCHED_A]],
      ["7.7777", [UNTOUCHED_A, UNTOUCHED_B]],
    ];

    for (const [charge, layers] of cases) {
      const plan = planRevaluation(charge, "VALUE", layers);
      for (const row of plan.rows) {
        // Row-level, in ten-thousandths, so no decimal helper is doing the work.
        const allocated = Math.round(Number(row.allocated) * 10000);
        const split =
          Math.round(Number(row.capitalised) * 10000) + Math.round(Number(row.expensed) * 10000);
        expect(split).toBe(allocated);
      }
      const total =
        Math.round(Number(plan.capitalisedTotal) * 10000) +
        Math.round(Number(plan.expensedTotal) * 10000);
      expect(total).toBe(Math.round(Number(charge) * 10000));
    }
  });
});
