import { BadRequestException } from "@nestjs/common";
import { addDec, cmpDec, divDec, mulDec, subDec } from "../stock-engine/decimal";

/**
 * NEO-9 - the arithmetic of building and breaking a kit, as pure functions.
 *
 * Kept out of the service for the reason the slotting ranker is: it is the part
 * with an opinion, and the opinion worth testing on its own is where the money
 * goes.
 */

export interface BomLine {
  componentVariantId: number;
  quantityPer: string;
}

export interface ComponentDemand extends BomLine {
  /** `quantityPer × kits`, exact. */
  quantityRequired: string;
}

export function explode(bom: readonly BomLine[], kits: string): ComponentDemand[] {
  if (bom.length === 0) {
    throw new BadRequestException("This SKU has no bill of materials, so it cannot be assembled");
  }
  return bom.map((line) => ({
    ...line,
    quantityRequired: mulDec(line.quantityPer, kits),
  }));
}

/**
 * How many whole kits the components on hand could make.
 *
 * The minimum over components of `floor(available / per)`. Whole kits only: half
 * a gift set is not a thing anybody can ship, and reporting 3.5 buildable would
 * be a number that becomes 3 the moment somebody acts on it.
 */
export function buildableKits(
  bom: readonly BomLine[],
  availableByComponent: ReadonlyMap<number, string>,
): string {
  if (bom.length === 0) return "0";

  let smallest: string | null = null;
  for (const line of bom) {
    const available = availableByComponent.get(line.componentVariantId) ?? "0";
    const whole = floorDec(divDec(available, line.quantityPer));
    if (smallest === null || cmpDec(whole, smallest) < 0) smallest = whole;
  }
  return smallest ?? "0";
}

/** Truncation towards zero, on the decimal string. Never `Math.floor(Number(x))`. */
function floorDec(value: string): string {
  const [whole = "0"] = value.split(".");
  return cmpDec(value, "0") < 0 ? "0" : `${whole}`;
}

export interface ShortComponent {
  componentVariantId: number;
  required: string;
  available: string;
}

/**
 * Which components cannot cover the build.
 *
 * Returns them **all** rather than the first: an assembler told "component 7 is
 * short", who then fixes it and is told "component 12 is short", has been made to
 * walk the warehouse twice for information the system had both times.
 */
export function shortComponents(
  demand: readonly ComponentDemand[],
  availableByComponent: ReadonlyMap<number, string>,
): ShortComponent[] {
  const short: ShortComponent[] = [];
  for (const line of demand) {
    const available = availableByComponent.get(line.componentVariantId) ?? "0";
    if (cmpDec(available, line.quantityRequired) < 0) {
      short.push({
        componentVariantId: line.componentVariantId,
        required: line.quantityRequired,
        available,
      });
    }
  }
  return short;
}

export interface ApportionedCost {
  componentVariantId: number;
  /** The share of the kit's cost this component gets back on a disassembly. */
  totalCost: string;
}

/**
 * Give a broken-up kit's cost back to its components, conserving value exactly.
 *
 * Apportioned by each component's *share of the build's cost* - `quantityPer ×
 * that component's current unit cost` - rather than by quantity, because a kit
 * of one expensive item and ten cheap ones does not lose most of its value to
 * the cheap ones. The last line takes the remainder, so the parts sum to the
 * whole to the last paise and a disassembly posts no variance nobody asked for.
 *
 * Weights that are all zero fall back to quantity, because a build whose
 * components all cost nothing still has to put its cost somewhere, and the
 * alternative is dividing by zero.
 */
export function apportionKitCost(
  kitTotalCost: string,
  lines: ReadonlyArray<{ componentVariantId: number; quantityRequired: string; unitCost: string }>,
): ApportionedCost[] {
  if (lines.length === 0) return [];

  const weights = lines.map((line) => mulDec(line.quantityRequired, line.unitCost));
  let totalWeight = weights.reduce((sum, weight) => addDec(sum, weight), "0");

  const fallback = cmpDec(totalWeight, "0") <= 0;
  const effective = fallback ? lines.map((line) => line.quantityRequired) : weights;
  if (fallback) totalWeight = effective.reduce((sum, weight) => addDec(sum, weight), "0");
  if (cmpDec(totalWeight, "0") <= 0) {
    return lines.map((line) => ({ componentVariantId: line.componentVariantId, totalCost: "0.0000" }));
  }

  const out: ApportionedCost[] = [];
  let assigned = "0";
  for (const [index, line] of lines.entries()) {
    const isLast = index === lines.length - 1;
    const share = isLast
      ? subDec(kitTotalCost, assigned)
      : mulDec(kitTotalCost, divDec(effective[index]!, totalWeight));
    assigned = addDec(assigned, share);
    out.push({ componentVariantId: line.componentVariantId, totalCost: share });
  }
  return out;
}
