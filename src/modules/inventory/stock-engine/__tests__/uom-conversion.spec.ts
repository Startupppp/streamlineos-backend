/**
 * INV-106 — entered quantities converted to base, exactly.
 *
 * The arithmetic is the part worth pinning. Every one of these cases is a number
 * that floating point gets wrong or that a naive scale-4 multiply truncates, and
 * each one would land in the ledger as a real quantity discrepancy.
 */
import { BadRequestException } from "@nestjs/common";
import { toBaseQuantity, UomConversionService } from "../uom-conversion.service";

describe("toBaseQuantity", () => {
  it.each([
    ["3", "12", "36.0000", "three dozen"],
    ["2.5", "12", "30.0000", "half a case"],
    ["1", "0.083333", "0.0833", "the inverse factor, rounded once at the end"],
    ["-4", "6", "-24.0000", "an issue, not a receipt"],
    ["0.0001", "1", "0.0001", "the smallest quantity the ledger holds"],
    ["1000000", "144", "144000000.0000", "a pallet count that overflows a float's integer range in cents"],
  ])("converts %s × %s to %s (%s)", (entered, factor, expected) => {
    expect(toBaseQuantity(entered, factor)).toBe(expected);
  });

  it("rounds half up at the fourth decimal, once", () => {
    // 1 × 0.00005 is exactly half a ten-thousandth. Rounding at each step would
    // reach a different answer than rounding once at the end.
    expect(toBaseQuantity("1", "0.00005")).toBe("0.0001");
    expect(toBaseQuantity("1", "0.00004")).toBe("0.0000");
  });

  it("is exact where a float is not", () => {
    // 0.1 + 0.2 !== 0.3 territory: 3 × 12 must not be 35.999999999999996.
    expect(toBaseQuantity("0.3", "0.1")).toBe("0.0300");
    expect(Number(toBaseQuantity("3", "12"))).toBe(36);
  });

  it("refuses a factor that would erase or invert the quantity", () => {
    expect(() => toBaseQuantity("5", "0")).toThrow(BadRequestException);
    expect(() => toBaseQuantity("5", "-2")).toThrow(BadRequestException);
  });

  it("refuses anything that is not a decimal", () => {
    for (const bad of ["", " ", "abc", "1.2.3", "1e5", "NaN", "Infinity"]) {
      expect(() => toBaseQuantity(bad, "1")).toThrow(BadRequestException);
    }
  });
});

describe("UomConversionService.factorFor", () => {
  const product = { id: 7, uomId: 100 };

  function build(overrides: {
    product?: unknown;
    uom?: unknown;
    conversion?: unknown;
  } = {}) {
    // `?? default` cannot express "explicitly absent" — passing undefined would
    // fall through to the default and the three absence cases below would pass
    // for the wrong reason. Presence of the key is the signal.
    const pick = <T>(key: keyof typeof overrides, fallback: T): T =>
      (key in overrides ? (overrides[key] as T) : fallback);
    const db = {
      query: {
        invProducts: { findFirst: jest.fn(async () => pick("product", product)) },
        invUom: {
          findFirst: jest.fn(async () => pick("uom", { id: 200, isActive: true, abbreviation: "CASE" })),
        },
        invProductUomConversions: {
          findFirst: jest.fn(async () => pick("conversion", { factorToBase: "12.000000" })),
        },
      },
    };
    return new UomConversionService(db as never);
  }

  it("needs no conversion row for the product's own base unit", async () => {
    // Requiring one would make every ordinary line fail.
    await expect(build().factorFor("org", product.id, product.uomId)).resolves.toBe("1.000000");
  });

  it("treats an absent unit as base", async () => {
    await expect(build().factorFor("org", product.id, null)).resolves.toBe("1.000000");
  });

  it("returns the configured factor for an alternate unit", async () => {
    await expect(build().factorFor("org", product.id, 200)).resolves.toBe("12.000000");
  });

  it("refuses an alternate unit with no conversion rather than assuming one", async () => {
    // Silently defaulting to 1 is how a pallet becomes a single unit.
    await expect(build({ conversion: undefined }).factorFor("org", product.id, 200)).rejects.toThrow(
      /No conversion from CASE/,
    );
  });

  it("refuses an inactive unit", async () => {
    await expect(
      build({ uom: { id: 200, isActive: false, abbreviation: "CASE" } }).factorFor("org", product.id, 200),
    ).rejects.toThrow(/inactive/);
  });

  it("refuses a unit that belongs to no tenant row", async () => {
    await expect(build({ uom: undefined }).factorFor("org", product.id, 200)).rejects.toThrow(
      /Unit of measure not found/,
    );
  });

  it("refuses a product that is not in the caller's tenant", async () => {
    await expect(build({ product: undefined }).factorFor("org", product.id, 200)).rejects.toThrow(
      /Product not found/,
    );
  });
});

describe("UomConversionService.convert", () => {
  it("returns the entered figures alongside the base quantity", async () => {
    const db = {
      query: {
        invProducts: { findFirst: jest.fn(async () => ({ id: 7, uomId: 100 })) },
        invUom: { findFirst: jest.fn(async () => ({ id: 200, isActive: true, abbreviation: "CASE" })) },
        invProductUomConversions: { findFirst: jest.fn(async () => ({ factorToBase: "12.000000" })) },
      },
    };
    const result = await new UomConversionService(db as never).convert("org", 7, 200, "3");

    // The line stores all four: what was typed, in what unit, at what factor,
    // and what the ledger holds. Dropping the factor is what lets a later
    // correction rewrite history.
    expect(result).toEqual({
      quantityEntered: "3",
      uomId: 200,
      uomFactor: "12.000000",
      quantity: "36.0000",
    });
  });

  it("keeps a posted line's arithmetic when the conversion is later corrected", async () => {
    const conversion = { factorToBase: "12.000000" };
    const db = {
      query: {
        invProducts: { findFirst: jest.fn(async () => ({ id: 7, uomId: 100 })) },
        invUom: { findFirst: jest.fn(async () => ({ id: 200, isActive: true, abbreviation: "CASE" })) },
        invProductUomConversions: { findFirst: jest.fn(async () => conversion) },
      },
    };
    const service = new UomConversionService(db as never);

    const posted = await service.convert("org", 7, 200, "3");
    conversion.factorToBase = "24.000000"; // somebody corrects the case size
    const laterLine = await service.convert("org", 7, 200, "3");

    // The new line sees the new factor; the posted one is unaffected, because
    // its factor is a value it already holds rather than a lookup.
    expect(laterLine.quantity).toBe("72.0000");
    expect(posted.quantity).toBe("36.0000");
    expect(toBaseQuantity(posted.quantityEntered, posted.uomFactor)).toBe("36.0000");
  });
});
