import { convertUomQty } from "../uom-conversion";

describe("convertUomQty", () => {
  it("converts kg to g (ratioToBase: kg=1, g=0.001)", () => {
    expect(convertUomQty(2, "1", 2, "0.001", 0)).toBe(2000);
  });

  it("converts g to kg", () => {
    expect(convertUomQty(500, "0.001", 2, "1", 3)).toBe(0.5);
  });

  it("same UOM returns same qty", () => {
    expect(convertUomQty(7, "1", 2, "1", 2)).toBe(7);
  });

  it("rounds to toRounding decimal places", () => {
    expect(convertUomQty(1, "1", 2, "3", 2)).toBeCloseTo(0.33, 2);
  });

  it("handles precision correctly for 0 decimal places", () => {
    expect(convertUomQty(1.5, "1", 2, "0.001", 0)).toBe(1500);
  });
});
