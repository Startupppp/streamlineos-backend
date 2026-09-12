import { BadRequestException } from "@nestjs/common";

/**
 * NEO-4 - the nesting rules, as pure functions.
 *
 * They are here rather than inline in the service because they are the whole of
 * "a nested carton does not double-count", and that claim is worth being able to
 * test without a database. The service applies them; nothing else may.
 *
 * ## The invariant
 *
 * Stock is held against a **leaf** handling unit and never against a parent. A
 * parent's contents are the union of its children's, computed, never stored.
 * There is therefore no second place the same twelve units could be written
 * down, and no aggregate that has to remember to exclude parents.
 *
 * Two rules keep it true, and both are refusals rather than repairs:
 *
 *   * a unit that holds stock may not be given children;
 *   * a unit that has children may not be given stock.
 *
 * A repair - moving the parent's stock down into a new child on nest, say -
 * would be a silent restatement of where somebody's inventory is, decided by
 * software at the moment they were doing something else.
 */

export interface HandlingUnitNode {
  id: number;
  parentHuId: number | null;
  locationId: number | null;
  status: string;
  /** True when at least one `inv_stock_levels` row names this unit with stock on it. */
  holdsStock: boolean;
  childCount: number;
}

export function assertCanHoldStock(unit: HandlingUnitNode): void {
  if (unit.childCount > 0) {
    throw new BadRequestException(
      "This handling unit contains other units. Stock is held on the innermost unit, so pack into one of its children instead.",
    );
  }
  if (unit.status === "SHIPPED") {
    throw new BadRequestException("This handling unit has shipped and cannot take stock");
  }
}

export function assertCanTakeChildren(parent: HandlingUnitNode): void {
  if (parent.holdsStock) {
    throw new BadRequestException(
      "This handling unit holds stock directly, so it cannot also contain other units. Move its stock out first.",
    );
  }
  if (parent.status === "SHIPPED") {
    throw new BadRequestException("This handling unit has shipped and cannot take other units");
  }
}

/**
 * Refuses a cycle, at any depth.
 *
 * The table's CHECK catches a unit being its own parent; a three-deep loop needs
 * the chain walked, and an unwalked one is a query that never returns rather than
 * an error somebody can read.
 *
 * `ancestorsOf` is the chain from the prospective parent upwards, nearest first.
 */
export function assertNoCycle(childId: number, ancestorsOf: readonly number[]): void {
  if (ancestorsOf.includes(childId)) {
    throw new BadRequestException(
      "That would put a handling unit inside itself",
    );
  }
}
