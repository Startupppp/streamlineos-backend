import { BadRequestException } from "@nestjs/common";
import {
  apportionKitCost,
  buildableKits,
  explode,
  shortComponents,
} from "../kit-math";

const BOM = [
  { componentVariantId: 10, quantityPer: "2.0000" },
  { componentVariantId: 11, quantityPer: "1.0000" },
];

describe("NEO-9 - exploding a bill of materials", () => {
  it("multiplies each component by the number of kits", () => {
    expect(explode(BOM, "3.0000")).toEqual([
      { componentVariantId: 10, quantityPer: "2.0000", quantityRequired: "6.0000" },
      { componentVariantId: 11, quantityPer: "1.0000", quantityRequired: "3.0000" },
    ]);
  });

  it("refuses a SKU with no bill of materials rather than building nothing", () => {
    expect(() => explode([], "1.0000")).toThrow(BadRequestException);
  });
});

describe("NEO-9 - what could be built", () => {
  it("is the minimum over components, in whole kits", () => {
    // Half a gift set is not a thing anybody can ship, and reporting 3.5 would
    // be a number that becomes 3 the moment somebody acts on it.
    const available = new Map([
      [10, "7.0000"],
      [11, "9.0000"],
    ]);
    expect(buildableKits(BOM, available)).toBe("3");
  });

  it("is zero when a component is missing entirely", () => {
    expect(buildableKits(BOM, new Map([[10, "100.0000"]]))).toBe("0");
  });
});

describe("NEO-9 - short components", () => {
  it("names every short component, not the first", () => {
    // An assembler told about one, who fixes it and is then told about another,
    // has walked the warehouse twice for information the system had both times.
    const demand = explode(BOM, "5.0000");
    const short = shortComponents(
      demand,
      new Map([
        [10, "3.0000"],
        [11, "1.0000"],
      ]),
    );
    expect(short.map((s) => s.componentVariantId)).toEqual([10, 11]);
    expect(short[0]).toEqual({ componentVariantId: 10, required: "10.0000", available: "3.0000" });
  });

  it("is empty when everything covers the build", () => {
    const demand = explode(BOM, "2.0000");
    expect(
      shortComponents(demand, new Map([[10, "4.0000"], [11, "2.0000"]])),
    ).toEqual([]);
  });
});

describe("NEO-9 - giving a broken kit's cost back", () => {
  it("conserves value exactly, to the last paise", () => {
    // A disassembly that loses or invents a paise is an accounting event nobody
    // asked for, and it would need a variance account this module has no
    // business creating.
    const shares = apportionKitCost("100.0000", [
      { componentVariantId: 10, quantityRequired: "2.0000", unitCost: "30.0000" },
      { componentVariantId: 11, quantityRequired: "1.0000", unitCost: "40.0000" },
      { componentVariantId: 12, quantityRequired: "3.0000", unitCost: "1.0000" },
    ]);

    const total = shares.reduce((sum, s) => sum + Number(s.totalCost), 0);
    expect(total).toBeCloseTo(100, 4);
  });

  it("apportions by cost share, not by quantity", () => {
    // A kit of one expensive item and ten cheap ones must not lose most of its
    // value to the cheap ones.
    const shares = apportionKitCost("110.0000", [
      { componentVariantId: 1, quantityRequired: "1.0000", unitCost: "100.0000" },
      { componentVariantId: 2, quantityRequired: "10.0000", unitCost: "1.0000" },
    ]);
    expect(Number(shares[0]!.totalCost)).toBeGreaterThan(Number(shares[1]!.totalCost));
  });

  it("falls back to quantity when every component costs nothing", () => {
    // The build's cost still has to go somewhere, and the alternative is
    // dividing by zero.
    const shares = apportionKitCost("60.0000", [
      { componentVariantId: 1, quantityRequired: "1.0000", unitCost: "0" },
      { componentVariantId: 2, quantityRequired: "2.0000", unitCost: "0" },
    ]);
    const total = shares.reduce((sum, s) => sum + Number(s.totalCost), 0);
    expect(total).toBeCloseTo(60, 4);
    expect(Number(shares[1]!.totalCost)).toBeGreaterThan(Number(shares[0]!.totalCost));
  });

  it("gives nothing back for an empty bill of materials", () => {
    expect(apportionKitCost("10.0000", [])).toEqual([]);
  });
});
