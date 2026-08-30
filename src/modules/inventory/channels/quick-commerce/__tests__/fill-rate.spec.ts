import { percentage } from "../fill-rate.service";

/**
 * NEO-3. The arithmetic, on its own.
 *
 * The service's queries need a database; the number a platform argues with does
 * not, and it is the half that has to be exact.
 */
describe("NEO-3 - fill rate percentage", () => {
  it("reports the work order's fixture: 10 ordered, 8 accepted, 80%", () => {
    expect(percentage("8.0000", "10.0000")).toBe("80.0000");
  });

  it("is exact where a float would not be", () => {
    // 1/3 of 100 is where a naive float percentage starts printing 33.33333333333333
    // into a document somebody reconciles by hand.
    expect(percentage("1.0000", "3.0000")).toBe("33.3300");
    expect(percentage("2.0000", "3.0000")).toBe("66.6700");
  });

  it("gives a purchase order that asked for nothing no fill rate at all", () => {
    // Not 100. A perfect score beside a document that ordered nothing is a green
    // number nobody can act on, and it would flatter every aggregate above it.
    expect(percentage("0.0000", "0.0000")).toBe("0.0000");
    expect(percentage("5.0000", "0.0000")).toBe("0.0000");
  });

  it("reports over-shipment as over 100 rather than clamping it", () => {
    // Shipping 12 against an order of 10 is a real event with a real consequence
    // at the platform's end. Clamping it to 100% would hide it.
    expect(percentage("12.0000", "10.0000")).toBe("120.0000");
  });
});
