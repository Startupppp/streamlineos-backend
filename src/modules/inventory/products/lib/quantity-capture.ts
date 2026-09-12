import { BadRequestException } from "@nestjs/common";

/**
 * E4 — what an entered quantity is allowed to look like, with no database in it.
 *
 * The rule this exists to hold is narrow and keeps being got wrong: a quantity
 * that arrives from a weighing scale is **an entered quantity with a unit**, not
 * a number. It travels as a decimal string at the ledger's own scale, it is
 * converted once by a factor that is snapshotted onto the line, and it never
 * becomes a JavaScript float on the way. `2.995 kg` parsed to a float and
 * multiplied by 1000 is 2994.9999999999995 grams, and that lands in the ledger
 * as a permanent 0.0005 g discrepancy that no count will ever explain.
 *
 * So this module validates strings and hands strings on. The conversion itself
 * already exists and is not reimplemented here — `UomConversionService.convert`
 * does it in BigInt and writes `quantityEntered`, `uomId` and `uomFactor` onto
 * the line, which is what stops a delivery counted in cases reaching the ledger
 * as that many singles.
 */

export type InvSaleMode = "PACKED" | "LOOSE";
export type InvQtyInputMode = "WHOLE" | "DECIMAL" | "SCALE";

/** How this SKU is sold and how a quantity for it may be entered. */
export interface QuantityCaptureRules {
  saleMode: InvSaleMode;
  inputMode: InvQtyInputMode;
  /** Decimal places allowed on entry. 0 for WHOLE, 1–4 otherwise; the pair is a DB CHECK. */
  precision: number;
}

/** The default a SKU carries before anyone configures it: countable, whole units. */
export const PACKED_WHOLE: QuantityCaptureRules = {
  saleMode: "PACKED",
  inputMode: "WHOLE",
  precision: 0,
};

const DECIMAL_TEXT = /^\d+(\.\d+)?$/;

function decimalPlaces(value: string): number {
  const dot = value.indexOf(".");
  return dot === -1 ? 0 : value.length - dot - 1;
}

/**
 * Refuses a quantity the SKU's entry contract does not allow.
 *
 * Refused rather than rounded. Rounding 1.005 tins to 1 tin is a silent
 * correction of somebody's intent, and rounding 2.9955 kg to 2.996 kg discards a
 * digit the scale actually sent — in one direction it invents stock and in the
 * other it loses it, and neither leaves a trace.
 */
export function assertEnteredQuantity(rules: QuantityCaptureRules, quantity: string): void {
  const text = quantity.trim();
  if (!DECIMAL_TEXT.test(text)) {
    throw new BadRequestException({
      code: "QUANTITY_NOT_DECIMAL",
      message: `"${quantity}" is not a quantity. Enter a positive decimal with up to ${rules.precision} decimal places.`,
    });
  }
  if (Number(text) === 0) {
    throw new BadRequestException({
      code: "QUANTITY_ZERO",
      message: "A quantity of zero moves nothing. Remove the line instead.",
    });
  }

  const places = decimalPlaces(text);
  if (rules.inputMode === "WHOLE" && places > 0) {
    throw new BadRequestException({
      code: "QUANTITY_MUST_BE_WHOLE",
      message: `This product is counted in whole units, so "${text}" is not a quantity it can be received or issued in.`,
    });
  }
  if (places > rules.precision) {
    throw new BadRequestException({
      code: "QUANTITY_PRECISION_EXCEEDED",
      message: `This product is measured to ${rules.precision} decimal place${rules.precision === 1 ? "" : "s"}, and "${text}" carries ${places}.`,
    });
  }
}

/**
 * Refuses a catalogue configuration that reads as configured and does nothing.
 *
 * The `WHOLE` ⇔ `precision = 0` pair is also a DB CHECK, and is asserted here as
 * well so the operator gets a sentence rather than a constraint name. The loose
 * rule has no DB half — nothing a CHECK can see distinguishes a loose product
 * from a packed one but the pair of columns it already covers.
 */
export function assertCaptureRulesCoherent(rules: QuantityCaptureRules): void {
  // Checked first, deliberately. Setting a loose SKU to whole-unit entry also
  // trips the precision pair, and "a loose product cannot be counted in whole
  // units" sends the operator to the field they actually changed, where
  // "precision must be 0" sends them to the one they did not.
  if (rules.saleMode === "LOOSE" && rules.inputMode === "WHOLE") {
    throw new BadRequestException({
      code: "LOOSE_NEEDS_MEASURED_ENTRY",
      message: "A loose product is measured out of bulk, so it cannot be entered in whole units. Set the input mode to DECIMAL or SCALE.",
    });
  }
  if (rules.inputMode === "WHOLE" && rules.precision !== 0) {
    throw new BadRequestException({
      code: "QTY_PRECISION_WITHOUT_MEASURE",
      message: "A product counted in whole units has no decimal places. Set a measured input mode, or leave the precision at 0.",
    });
  }
  if (rules.inputMode !== "WHOLE" && (rules.precision < 1 || rules.precision > 4)) {
    throw new BadRequestException({
      code: "QTY_PRECISION_OUT_OF_RANGE",
      message: "A measured product needs between 1 and 4 decimal places — 4 is the scale the stock ledger itself holds.",
    });
  }
}

/**
 * A selling or purchasing unit that is not the stock unit needs a factor.
 *
 * This is the E4 bug in its purest form: the SKU sells in grams, the ledger
 * holds kilograms, and with no conversion row every sale of 500 g removes
 * 500 kg. `UomConversionService.factorFor` already refuses at the moment of use
 * — this refuses at the moment of configuration, which is the difference between
 * a message the catalogue owner can act on and one the counter gets mid-sale.
 */
export function assertUnitConvertible(
  unitLabel: string,
  fieldName: string,
  hasConversion: boolean,
): void {
  if (hasConversion) return;
  throw new BadRequestException({
    code: "UOM_CONVERSION_MISSING",
    message: `${fieldName} is ${unitLabel}, which is not this product's stock unit, and there is no conversion between them. Add the conversion before the unit can be used on a document.`,
  });
}
