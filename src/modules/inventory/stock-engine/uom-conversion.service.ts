import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { invProductUomConversions, invProducts, invUom } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";

/**
 * Entered quantities, converted to base UOM exactly — INV-106.
 *
 * `inv_product_uom_conversions` has existed with no readers, so every document
 * quantity was taken as base whatever unit the operator meant. Two rules make
 * that safe rather than merely working:
 *
 * The ledger only ever holds base UOM. A movement in "cases" is not a movement
 * anybody can add up across products.
 *
 * The applied factor is stored on the line. Looked up at read time instead, a
 * correction to a case size would silently rewrite what every historical
 * document meant — "3 cases" received last year would become a different number
 * of units. Snapshotted, a posted document keeps the arithmetic it was posted
 * with, and only new lines see the new factor.
 */

/** Scale of the stored factor, matching numeric(18,6) in the migration. */
const FACTOR_SCALE = 6n;
const FACTOR_UNIT = 10n ** FACTOR_SCALE;
/** Scale of every quantity in the ledger. */
const QTY_SCALE = 4n;
const QTY_UNIT = 10n ** QTY_SCALE;

export interface ConvertedQuantity {
  /** What the operator typed, preserved verbatim. */
  quantityEntered: string;
  /** The unit they typed it in, or null when they typed base units. */
  uomId: number | null;
  /** The factor applied, snapshotted onto the line. */
  uomFactor: string;
  /** The base-UOM quantity the ledger stores. */
  quantity: string;
}

function parseScaled(value: string, unit: bigint): bigint {
  const text = value.trim();
  if (!/^[+-]?\d+(\.\d+)?$/.test(text)) throw new BadRequestException(`Not a decimal quantity: ${value}`);
  const negative = text.startsWith("-");
  const body = negative || text.startsWith("+") ? text.slice(1) : text;
  const [whole = "0", fraction = ""] = body.split(".");
  const width = unit.toString().length - 1;
  // One extra digit, to round on rather than truncate.
  const padded = (fraction + "0".repeat(width + 1)).slice(0, width + 1);
  let scaled = BigInt(whole || "0") * unit + BigInt(padded.slice(0, width) || "0");
  if (Number(padded[width]) >= 5) scaled += 1n;
  return negative ? -scaled : scaled;
}

function formatScaled(value: bigint, unit: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const width = unit.toString().length - 1;
  return `${negative ? "-" : ""}${(absolute / unit).toString()}.${(absolute % unit).toString().padStart(width, "0")}`;
}

/**
 * entered × factor, rounded half-up to the ledger's four decimal places.
 *
 * The multiplication is exact — both operands are integers at their own scale —
 * and rounding happens once, at the end. Doing it in floating point is how a
 * receipt of 3 cases of 12 becomes 35.999999999999996.
 */
export function toBaseQuantity(entered: string, factor: string): string {
  const enteredScaled = parseScaled(entered, QTY_UNIT);
  const factorScaled = parseScaled(factor, FACTOR_UNIT);
  if (factorScaled <= 0n) throw new BadRequestException("A unit conversion factor must be greater than zero");

  const product = enteredScaled * factorScaled;
  const negative = product < 0n;
  const absolute = negative ? -product : product;
  const quotient = absolute / FACTOR_UNIT;
  const remainder = absolute % FACTOR_UNIT;
  const rounded = remainder * 2n >= FACTOR_UNIT ? quotient + 1n : quotient;
  return formatScaled(negative ? -rounded : rounded, QTY_UNIT);
}

@Injectable()
export class UomConversionService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * Resolves the factor for a unit on a product.
   *
   * The product's own base unit is 1 by definition and needs no conversion row —
   * requiring one would make every ordinary line fail.
   */
  async factorFor(orgId: string, productId: number, uomId: number | null): Promise<string> {
    if (uomId === null) return "1.000000";

    const product = await this.db.query.invProducts.findFirst({
      where: and(eq(invProducts.id, productId), eq(invProducts.orgId, orgId)),
      columns: { id: true, uomId: true },
    });
    if (!product) throw new BadRequestException("Product not found");
    if (product.uomId === uomId) return "1.000000";

    const unit = await this.db.query.invUom.findFirst({
      where: and(eq(invUom.id, uomId), eq(invUom.orgId, orgId)),
      columns: { id: true, isActive: true, abbreviation: true },
    });
    if (!unit) throw new BadRequestException("Unit of measure not found");
    if (!unit.isActive) throw new BadRequestException(`Unit ${unit.abbreviation} is inactive`);

    const conversion = await this.db.query.invProductUomConversions.findFirst({
      where: and(
        eq(invProductUomConversions.orgId, orgId),
        eq(invProductUomConversions.productId, productId),
        eq(invProductUomConversions.uomId, uomId),
      ),
      columns: { factorToBase: true },
    });
    // Refused rather than assumed to be 1: silently treating an unconvertible
    // unit as base is how a pallet becomes a single unit.
    if (!conversion)
      throw new BadRequestException(`No conversion from ${unit.abbreviation} to this product's base unit`);

    return conversion.factorToBase;
  }

  /** Resolves the factor and applies it, returning everything the line stores. */
  async convert(
    orgId: string,
    productId: number,
    uomId: number | null,
    quantityEntered: string,
  ): Promise<ConvertedQuantity> {
    const uomFactor = await this.factorFor(orgId, productId, uomId);
    return {
      quantityEntered,
      uomId,
      uomFactor,
      quantity: toBaseQuantity(quantityEntered, uomFactor),
    };
  }
}
