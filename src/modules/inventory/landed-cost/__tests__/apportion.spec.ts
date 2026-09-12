import {
  apportion,
  centsToDecimal,
  fromScaled,
  splitByRemaining,
  toScaled,
} from "../lib/apportion";

/**
 * G5 — the apportionment, against figures worked out by hand.
 *
 * Every expected value below is a literal. None of them is the same expression
 * the implementation runs, computed a second time in the test: two specs in this
 * repository were found asserting their own arithmetic against itself, which is a
 * test that cannot fail and therefore is not one. Where a figure is not obvious
 * the working is in the comment above it.
 */
describe("G5 — apportioning a landed cost", () => {
  describe("scaling", () => {
    it("round-trips a four-decimal string exactly", () => {
      expect(toScaled("4.4000")).toBe(44000n);
      expect(toScaled("0.0001")).toBe(1n);
      expect(toScaled("1000")).toBe(10000000n);
      expect(fromScaled(44000n)).toBe("4.4000");
      expect(fromScaled(1n)).toBe("0.0001");
      expect(fromScaled(0n)).toBe("0.0000");
    });

    it("converts integer minor units without rounding anything", () => {
      // Money is cents; the layers are numeric(18,4). One cent is 0.0100, so the
      // conversion is exact in both directions and no decision is taken here.
      expect(centsToDecimal(1n)).toBe("0.0100");
      expect(centsToDecimal(3333n)).toBe("33.3300");
      expect(centsToDecimal(10000n)).toBe("100.0000");
      expect(centsToDecimal(0n)).toBe("0.0000");
    });
  });

  describe("dividing a charge across layers", () => {
    it("splits in proportion to value when the division is exact", () => {
      // 100.00 of freight over layers worth 400.00 and 600.00 — two fifths and
      // three fifths.
      const shares = apportion("100.0000", [
        { id: 1, weight: "400.0000" },
        { id: 2, weight: "600.0000" },
      ]);
      expect(shares).toEqual([
        { id: 1, amount: "40.0000" },
        { id: 2, amount: "60.0000" },
      ]);
    });

    it("gives the indivisible remainder to a named layer rather than dropping it", () => {
      // 100.00 across three equal layers is 33.333333… each. Floored to the
      // 1/10000 grain that is 33.3333 three times = 99.9999, leaving one
      // ten-thousandth. The remainders are equal, so the tie breaks on the lower
      // id and layer 1 takes it.
      const shares = apportion("100.0000", [
        { id: 1, weight: "1.0000" },
        { id: 2, weight: "1.0000" },
        { id: 3, weight: "1.0000" },
      ]);
      expect(shares).toEqual([
        { id: 1, amount: "33.3334" },
        { id: 2, amount: "33.3333" },
        { id: 3, amount: "33.3333" },
      ]);
    });

    it("gives it to the largest shortfall, not to the first or the last row", () => {
      // 10.00 by quantity across 100 and 50 units. Exact shares are 6.666666…
      // and 3.333333…; floored they are 6.6666 and 3.3333, leaving one
      // ten-thousandth. The 100-unit layer was cut by two thirds of a grain and
      // the 50-unit layer by one third, so the 100-unit layer takes it.
      const shares = apportion("10.0000", [
        { id: 7, weight: "100.0000" },
        { id: 8, weight: "50.0000" },
      ]);
      expect(shares).toEqual([
        { id: 7, amount: "6.6667" },
        { id: 8, amount: "3.3333" },
      ]);
    });

    it("breaks an equal-remainder tie on the larger weight before the id", () => {
      // 1.0000 across weights 2, 2 and 1: exact shares 0.4000, 0.4000, 0.2000 —
      // no remainder at all, so the tie-break never fires and every row is exact.
      expect(
        apportion("1.0000", [
          { id: 3, weight: "2.0000" },
          { id: 1, weight: "2.0000" },
          { id: 2, weight: "1.0000" },
        ]),
      ).toEqual([
        { id: 3, amount: "0.4000" },
        { id: 1, amount: "0.4000" },
        { id: 2, amount: "0.2000" },
      ]);

      // 1.0000 across weights 3, 3 and 1: 0.4285(71…), 0.4285(71…), 0.1428(57…).
      // Floors are 4285, 4285, 1428 = 0.9998, leaving two ten-thousandths. The
      // two heavy rows share the largest remainder, so they take one each and the
      // light row is left alone — the order the rows arrived in does not matter.
      expect(
        apportion("1.0000", [
          { id: 9, weight: "3.0000" },
          { id: 4, weight: "1.0000" },
          { id: 6, weight: "3.0000" },
        ]),
      ).toEqual([
        { id: 9, amount: "0.4286" },
        { id: 4, amount: "0.1428" },
        { id: 6, amount: "0.4286" },
      ]);
    });

    it("always adds back up to the charge", () => {
      // The property behind every case above, on a deliberately awkward split:
      // seven layers of unequal value and a total that divides into none of them.
      const shares = apportion("99.9999", [
        { id: 1, weight: "13.0000" },
        { id: 2, weight: "7.0000" },
        { id: 3, weight: "0.0001" },
        { id: 4, weight: "101.5000" },
        { id: 5, weight: "3.3333" },
        { id: 6, weight: "0.5000" },
        { id: 7, weight: "22.0000" },
      ]);
      const total = shares.reduce((sum, share) => sum + toScaled(share.amount), 0n);
      expect(fromScaled(total)).toBe("99.9999");
    });

    it("refuses a division it cannot defend", () => {
      // Weights of zero: spreading equally would invent a basis nobody chose and
      // returning zeros would lose the charge. The service refuses first with a
      // message naming the basis; this is the backstop behind it.
      expect(() =>
        apportion("10.0000", [
          { id: 1, weight: "0.0000" },
          { id: 2, weight: "0.0000" },
        ]),
      ).toThrow(RangeError);
      expect(() => apportion("10.0000", [])).toThrow(RangeError);
      expect(() => apportion("10.0000", [{ id: 1, weight: "-1.0000" }])).toThrow(RangeError);
    });

    it("spreads nothing across zero weights without complaint", () => {
      expect(apportion("0.0000", [{ id: 1, weight: "0.0000" }])).toEqual([
        { id: 1, amount: "0.0000" },
      ]);
    });
  });

  describe("splitting one layer between stock still held and stock already gone", () => {
    it("capitalises the whole allocation when nothing has been issued", () => {
      expect(splitByRemaining("100.0000", "100.0000", "100.0000")).toEqual({
        capitalisable: "100.0000",
        expensed: "0.0000",
      });
    });

    it("expenses the whole allocation when the layer is empty", () => {
      expect(splitByRemaining("100.0000", "0.0000", "100.0000")).toEqual({
        capitalisable: "0.0000",
        expensed: "100.0000",
      });
    });

    it("splits on the proportion still held", () => {
      // 40 of 100 units left, so two fifths of the freight can still reach stock.
      expect(splitByRemaining("100.0000", "40.0000", "100.0000")).toEqual({
        capitalisable: "40.0000",
        expensed: "60.0000",
      });
    });

    it("sends the odd ten-thousandth to the expensed side", () => {
      // 10.0000 over a layer with 1 of 3 units left. A third of 10 is 3.333333…;
      // floored to 3.3333 on the capitalisable side, and the rest — 6.6667 —
      // expensed. Conservative by rule: capitalising defers cost, expensing takes
      // it now.
      expect(splitByRemaining("10.0000", "1.0000", "3.0000")).toEqual({
        capitalisable: "3.3333",
        expensed: "6.6667",
      });
    });
  });
});
