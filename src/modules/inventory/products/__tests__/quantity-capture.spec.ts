import { BadRequestException } from "@nestjs/common";
import {
  assertCaptureRulesCoherent,
  assertEnteredQuantity,
  assertUnitConvertible,
  PACKED_WHOLE,
  type QuantityCaptureRules,
} from "../lib/quantity-capture";
import { toBaseQuantity } from "../../stock-engine/uom-conversion.service";

/**
 * E4 — what an entered quantity may look like, and what the conversion does with
 * it.
 *
 * The conversion cases are here rather than only in the stock engine's own tests
 * because they are the reason the entry rules exist: a scale reading is an
 * entered quantity with a unit, and the arithmetic that turns it into base units
 * has to be exact or the rules are decoration.
 */

const scaleKg: QuantityCaptureRules = { saleMode: "LOOSE", inputMode: "SCALE", precision: 3 };

describe("E4 entered quantity", () => {
  it("accepts a whole count on a packed SKU and refuses a fraction of one", () => {
    expect(() => assertEnteredQuantity(PACKED_WHOLE, "3")).not.toThrow();
    expect(() => assertEnteredQuantity(PACKED_WHOLE, "3.25")).toThrow(BadRequestException);
  });

  it("accepts a reading at the SKU's precision and refuses one digit more", () => {
    expect(() => assertEnteredQuantity(scaleKg, "2.995")).not.toThrow();
    expect(() => assertEnteredQuantity(scaleKg, "2.9955")).toThrow(BadRequestException);
  });

  it("refuses rather than rounds", () => {
    // Rounding 2.9955 to 2.996 invents 0.5 g of stock and leaves no trace, and
    // rounding down loses it. Both are worse than a message.
    try {
      assertEnteredQuantity(scaleKg, "2.9955");
      throw new Error("expected a refusal");
    } catch (err) {
      const body = (err as BadRequestException).getResponse() as { code: string };
      expect(body.code).toBe("QUANTITY_PRECISION_EXCEEDED");
    }
  });

  it("refuses zero and refuses anything that is not a decimal", () => {
    expect(() => assertEnteredQuantity(scaleKg, "0")).toThrow(BadRequestException);
    expect(() => assertEnteredQuantity(scaleKg, "0.000")).toThrow(BadRequestException);
    expect(() => assertEnteredQuantity(scaleKg, "-1")).toThrow(BadRequestException);
    expect(() => assertEnteredQuantity(scaleKg, "2,995")).toThrow(BadRequestException);
    expect(() => assertEnteredQuantity(scaleKg, "1e3")).toThrow(BadRequestException);
  });
});

describe("E4 capture configuration", () => {
  it("accepts the default a SKU is created with", () => {
    expect(() => assertCaptureRulesCoherent(PACKED_WHOLE)).not.toThrow();
  });

  it("refuses decimal places on a SKU counted in whole units", () => {
    expect(() => assertCaptureRulesCoherent({ ...PACKED_WHOLE, precision: 3 })).toThrow(BadRequestException);
  });

  it("refuses a measured SKU with no decimal places, which would reject every reading", () => {
    expect(() =>
      assertCaptureRulesCoherent({ saleMode: "PACKED", inputMode: "SCALE", precision: 0 }),
    ).toThrow(BadRequestException);
  });

  it("refuses a loose SKU entered in whole units", () => {
    expect(() =>
      assertCaptureRulesCoherent({ saleMode: "LOOSE", inputMode: "WHOLE", precision: 0 }),
    ).toThrow(BadRequestException);
  });

  it("refuses a selling unit with no conversion to the stock unit", () => {
    expect(() => assertUnitConvertible("g", "salesUomId", true)).not.toThrow();
    expect(() => assertUnitConvertible("g", "salesUomId", false)).toThrow(BadRequestException);
  });
});

describe("E4 conversion snapshot — hand-worked", () => {
  /**
   * Receive in kilograms, sell in grams, stock held in kilograms. Every figure
   * below is worked by hand and written as a literal; recomputing it in the test
   * would only prove the implementation agrees with itself.
   */
  it("receives 25 kg as 25 base units", () => {
    expect(toBaseQuantity("25", "1.000000")).toBe("25.0000");
  });

  it("sells 500 g as 0.5 base units", () => {
    expect(toBaseQuantity("500", "0.00100000")).toBe("0.5000");
  });

  it("keeps a scale's third digit exactly", () => {
    // 2.995 kg is 2995 g. In floating point 2.995 × 1000 is 2994.9999999999995,
    // which is the whole reason the conversion is BigInt.
    expect(toBaseQuantity("2.995", "1000.000000")).toBe("2995.0000");
    expect(toBaseQuantity("2.995", "1.000000")).toBe("2.9950");
  });

  it("does not turn a case of twelve into twelve singles", () => {
    // The B1 bug, restated as arithmetic: three cases of twelve is 36, and 36 is
    // what the ledger has to receive.
    expect(toBaseQuantity("3", "12.000000")).toBe("36.0000");
  });
});
