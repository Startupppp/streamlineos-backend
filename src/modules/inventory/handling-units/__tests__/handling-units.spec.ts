import { BadRequestException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  assertCanHoldStock,
  assertCanTakeChildren,
  assertNoCycle,
  type HandlingUnitNode,
} from "../handling-unit-rules";
import { levelKey, type LevelGrain } from "../../stock-engine/stock-level-locks";
import { EXPECTED_COMMITTED, EXPECTED_OUTGOING } from "../../stock-engine/projection-definitions";

function node(overrides: Partial<HandlingUnitNode> = {}): HandlingUnitNode {
  return {
    id: 1,
    parentHuId: null,
    locationId: 5,
    status: "OPEN",
    holdsStock: false,
    childCount: 0,
    ...overrides,
  };
}

describe("NEO-4 - stock lives on leaves", () => {
  it("lets an empty leaf take stock", () => {
    expect(() => assertCanHoldStock(node())).not.toThrow();
  });

  it("refuses to put stock on a unit that contains other units", () => {
    // This is the half of the invariant that makes double-counting impossible:
    // if a parent could hold stock of its own, a roll-up would have to remember
    // to exclude it, and one day it would not.
    expect(() => assertCanHoldStock(node({ childCount: 2 }))).toThrow(BadRequestException);
    expect(() => assertCanHoldStock(node({ childCount: 2 }))).toThrow(/innermost unit/);
  });

  it("refuses to nest under a unit that already holds stock", () => {
    // The other half. Together they mean a unit is either a container or a
    // holder and never both, so there is no second place the same units exist.
    expect(() => assertCanTakeChildren(node({ holdsStock: true }))).toThrow(BadRequestException);
  });

  it("refuses either operation once the unit has shipped", () => {
    expect(() => assertCanHoldStock(node({ status: "SHIPPED" }))).toThrow(/shipped/);
    expect(() => assertCanTakeChildren(node({ status: "SHIPPED" }))).toThrow(/shipped/);
  });

  it("refuses a cycle at any depth, not only the one-hop case", () => {
    // The table CHECK catches a unit being its own parent. A three-deep loop
    // needs the chain walked, and an unwalked one is a query that never returns
    // rather than an error somebody can read.
    expect(() => assertNoCycle(7, [3, 5, 7])).toThrow(/inside itself/);
    expect(() => assertNoCycle(7, [3, 5, 9])).not.toThrow();
  });
});

describe("NEO-4 - the handling unit is part of the natural key", () => {
  const base: LevelGrain = {
    productVariantId: 2,
    locationId: 9,
    lotId: 4,
    serialId: null,
    handlingUnitId: null,
    ownership: "OWNED",
  };

  it("tells a pallet's stock apart from the loose stock beside it", () => {
    // Same SKU, same bin, same lot, different pallet. If these collapsed to one
    // key the engine would post a pallet movement onto the loose row.
    expect(levelKey(base)).not.toBe(levelKey({ ...base, handlingUnitId: 11 }));
  });

  it("tells two pallets at the same bin apart", () => {
    expect(levelKey({ ...base, handlingUnitId: 11 })).not.toBe(
      levelKey({ ...base, handlingUnitId: 12 }),
    );
  });
});

describe("NEO-4 - the projections follow the key", () => {
  const render = (sql: typeof EXPECTED_COMMITTED) => new PgDialect().sqlToQuery(sql).sql;

  it("matches reservations on the handling unit", () => {
    // Without this a promise made against a pallet would decrement `committed`
    // on the loose row at the same bin, and the units would read as reserved for
    // ever - the defect this file's own history is about, one grain deeper.
    expect(render(EXPECTED_COMMITTED)).toContain(
      "res.handling_unit_id IS NOT DISTINCT FROM sl.handling_unit_id",
    );
  });

  it("matches pick lines on the handling unit", () => {
    expect(render(EXPECTED_OUTGOING)).toContain(
      "pll.handling_unit_id IS NOT DISTINCT FROM sl.handling_unit_id",
    );
  });
});
