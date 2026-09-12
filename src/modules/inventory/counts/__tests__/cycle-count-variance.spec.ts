import { buildCountVarianceMovements } from "../count-variance-movements";

/**
 * This file used to declare `computeVariance`, `classifyMovement` and
 * `buildMovements` inside itself and assert against those. It imported
 * nothing — twelve green assertions that would have stayed green if the
 * counts module were deleted. Worse, its private `buildMovements` copy
 * reproduced the two defects the real code had, so the bug was written down
 * as the specification: no `lotId` on the movement, and `parseFloat` then
 * `toFixed(4)` on a `numeric(18,4)` quantity.
 *
 * It now imports the one function both posting paths actually call.
 */
describe("buildCountVarianceMovements", () => {
  const line = (over: Partial<Parameters<typeof buildCountVarianceMovements>[0][number]> = {}) => ({
    productVariantId: 1,
    locationId: 10,
    lotId: null,
    varianceQty: "0.0000",
    ...over,
  });

  describe("which lines move stock", () => {
    it("drops a line that was never counted", () => {
      expect(buildCountVarianceMovements([line({ varianceQty: null })])).toHaveLength(0);
    });

    it("drops a line the counter agreed with", () => {
      expect(buildCountVarianceMovements([line({ varianceQty: "0.0000" })])).toHaveLength(0);
    });

    it("moves a line that found more than the books said", () => {
      const [movement] = buildCountVarianceMovements([line({ varianceQty: "5.0000" })]);
      expect(movement?.transactionType).toBe("CYCLE_COUNT_GAIN");
    });

    it("moves a line that found less than the books said", () => {
      const [movement] = buildCountVarianceMovements([line({ varianceQty: "-3.0000" })]);
      expect(movement?.transactionType).toBe("CYCLE_COUNT_LOSS");
    });

    it("reads a negative zero as agreement, not as a loss", () => {
      expect(buildCountVarianceMovements([line({ varianceQty: "-0.0000" })])).toHaveLength(0);
    });
  });

  describe("the grain the count was taken at", () => {
    it("carries the lot the line was counted against", () => {
      const [movement] = buildCountVarianceMovements([line({ lotId: 77, varianceQty: "-2.0000" })]);
      expect(movement?.lotId).toBe(77);
    });

    it("leaves the lot absent for loose stock rather than inventing one", () => {
      const [movement] = buildCountVarianceMovements([line({ lotId: null, varianceQty: "-2.0000" })]);
      expect(movement?.lotId).toBeUndefined();
    });

    it("keeps two lots in one bin apart instead of netting them off", () => {
      const movements = buildCountVarianceMovements([
        line({ lotId: 1, varianceQty: "-4.0000" }),
        line({ lotId: 2, varianceQty: "4.0000" }),
      ]);
      expect(movements).toHaveLength(2);
      expect(movements.map((m) => m.lotId)).toEqual([1, 2]);
    });
  });

  describe("the quantity survives the trip", () => {
    it("passes the stored decimal through untouched", () => {
      const [movement] = buildCountVarianceMovements([line({ varianceQty: "-3.0000" })]);
      expect(movement?.quantityDelta).toBe("-3.0000");
    });

    it("keeps a quantity a float would round away", () => {
      // 8.2 as a float is 8.199999999999999, and 0.1 + 0.2 is 0.30000000000000004.
      // Passing the string through is what makes this exact.
      const [movement] = buildCountVarianceMovements([line({ varianceQty: "0.0001" })]);
      expect(movement?.quantityDelta).toBe("0.0001");
    });

    it("keeps every digit of a quantity wider than a double can hold", () => {
      const [movement] = buildCountVarianceMovements([line({ varianceQty: "1234567890123.4567" })]);
      expect(movement?.quantityDelta).toBe("1234567890123.4567");
    });
  });
});
