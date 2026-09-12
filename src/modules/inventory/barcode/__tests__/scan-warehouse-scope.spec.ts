import { invLocations, invUserWarehouses } from "../../../../db/schema";
import { WarehouseScopeService, SCOPE_ALL_PERMISSION } from "../../stock-engine/warehouse-scope.service";
import { InvBarcodeService } from "../inv-barcode.service";

/**
 * The barcode surface answers two questions with two different scopes, and
 * nothing in this folder scoped anything before. These pin both halves,
 * because each is a defect on its own:
 *
 *  - narrowing the *quantity* is the fix, and it is invisible in every test
 *    that only asserts a lookup resolved;
 *  - narrowing the *identity* would be a regression, and it is invisible in
 *    every test that only asserts a caller cannot see another building's
 *    stock. A change that scoped the SKU lookup too would pass a suite that
 *    tested only the first half, and break picking in the ordinary case.
 *
 * So the anti-over-narrowing floor below is not padding; it is the half a
 * reviewer skims past.
 */

/**
 * The columns a `where` compares against — `["org_id", "barcode", "deleted_at"]`
 * for the barcode probe, `["org_id", "sku", ...]` for the SKU one.
 *
 * `lookup` fires four catalogue probes at once and two of them hit the same
 * table, so a stub that answers every call identically cannot tell which
 * branch replied — and an over-narrowing regression then falls through to the
 * next branch and produces a byte-identical result. Only `queryChunks` is
 * walked: a Drizzle column carries a back-reference to its table, so recursing
 * blindly returns every column the table has.
 */
function comparedColumns(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (typeof record.name === "string" && typeof record.columnType === "string")
    return [record.name];
  if (Array.isArray(value)) return value.flatMap(comparedColumns);
  return Array.isArray(record.queryChunks) ? record.queryChunks.flatMap(comparedColumns) : [];
}

/** Walk a Drizzle SQL object for the bound parameter values it carries. */
function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value")
      ? sqlValues(record.value, seen)
      : []),
  ];
}

const VARIANT = { id: 5, productId: 1, name: "Widget", sku: "W-001", isActive: true };

interface SceneOptions {
  /** Warehouses assigned to the caller in `inv_user_warehouses`. */
  assigned?: number[];
  /** Whether the caller holds `inventory:warehouses:scope-all`. */
  scopeAll?: boolean;
  /** A bin the code resolves to, instead of a variant. */
  location?: { id: number; warehouseId: number } | null;
}

function buildScene(opts: SceneOptions = {}) {
  const { assigned = [], scopeAll = false, location = null } = opts;

  // The real WarehouseScopeService, over a fake `inv_user_warehouses`. Stubbing
  // it out would leave the predicate builders untested, and the predicate is
  // the entire mechanism.
  const scopeRows = assigned.map((warehouseId) => ({ warehouseId }));
  const scopeDb = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => (table === invUserWarehouses ? Promise.resolve(scopeRows) : Promise.resolve([])),
      }),
    }),
  };
  const access = {
    resolveUserPermissions: async () =>
      new Map(scopeAll ? [[SCOPE_ALL_PERMISSION, "all"]] : []),
  };
  const warehouseScope = new WarehouseScopeService(scopeDb as never, access as never);

  /** Every `where` the stock sum was built with, and every table it joined. */
  const stockWheres: unknown[] = [];
  const joinedTables: unknown[] = [];
  const selectCalls = jest.fn();

  const db = {
    query: {
      invProducts: { findFirst: async () => undefined },
      // Answers the *barcode* probe only. The SKU probe comes back empty, so
      // exactly one branch can produce the variant result and a regression
      // that skips it shows up as `not_found` rather than as the same object
      // arriving from one branch further down.
      invProductVariants: {
        findFirst: async (args: { where?: unknown }) =>
          !location && comparedColumns(args?.where).includes("barcode") ? VARIANT : undefined,
      },
      invLots: { findFirst: async () => undefined },
      invSerialNumbers: { findFirst: async () => undefined },
      invLocations: {
        findFirst: async () =>
          location
            ? {
                id: location.id,
                warehouseId: location.warehouseId,
                name: "Bin A-01",
                code: "A-01",
                locationType: "BIN",
                isActive: true,
              }
            : undefined,
      },
    },
    select: () => {
      selectCalls();
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.innerJoin = (table: unknown) => {
        joinedTables.push(table);
        return chain;
      };
      chain.where = (condition: unknown) => {
        stockWheres.push(condition);
        return Promise.resolve([{ total: "42.0000" }]);
      };
      return chain;
    },
  };

  const pharmacy = {
    dispensingProfile: async () => ({
      safety: { alerts: [], blocksDispense: false as const, acknowledgementRequired: false },
    }),
  };

  return {
    service: new InvBarcodeService(db as never, pharmacy as never, warehouseScope),
    stockWheres,
    joinedTables,
    selectCalls,
  };
}

describe("barcode lookup — the quantity is scoped to the caller's warehouses", () => {
  it("narrows the sum through inv_locations to the warehouses the caller holds", async () => {
    const scene = buildScene({ assigned: [7] });

    const result = await scene.service.lookup("org1", "user1", "W-001");

    expect(result).toMatchObject({ type: "variant", totalOnHand: "42.0000" });
    // The join is the mechanism: inv_stock_levels is keyed on a location, so
    // without inv_locations there is no warehouse_id to narrow by and the sum
    // silently goes organisation-wide again.
    expect(scene.joinedTables).toContain(invLocations);
    expect(sqlValues(scene.stockWheres[0])).toContain(7);
  });

  it("leaves the sum organisation-wide for a caller holding inventory:warehouses:scope-all", async () => {
    // The cross-building enquiry, already separately permissioned. A caller who
    // holds it sees exactly what this endpoint returned before it was scoped.
    const scene = buildScene({ scopeAll: true, assigned: [7] });

    const result = await scene.service.lookup("org1", "user1", "W-001");

    expect(result).toMatchObject({ type: "variant", totalOnHand: "42.0000" });
    // The assignment above is deliberately non-empty: scope-all must win over
    // it, or the permission would narrow the very callers it is meant to widen.
    expect(sqlValues(scene.stockWheres[0])).not.toContain(7);
  });

  it("answers 0 for a caller assigned to no warehouse, without running the stock query", async () => {
    const scene = buildScene({ assigned: [] });

    const result = await scene.service.lookup("org1", "user1", "W-001");

    expect(result).toMatchObject({ type: "variant", totalOnHand: "0" });
    expect(scene.selectCalls).not.toHaveBeenCalled();
  });
});

describe("barcode lookup — a bin is the one identity that is scoped", () => {
  it("does not resolve a bin in a building the caller does not hold", async () => {
    // A bin does not move, so resolving one names a building. Answering
    // not_found rather than 403 is the same reason assertWarehouseVisible
    // answers NotFound: a refusal that confirms the record exists is an
    // existence oracle over bin codes.
    const scene = buildScene({ assigned: [7], location: { id: 3, warehouseId: 9 } });

    const result = await scene.service.lookup("org1", "user1", "A-01");

    expect(result).toEqual({ type: "not_found" });
  });

  it("resolves a bin in a building the caller does hold", async () => {
    const scene = buildScene({ assigned: [9], location: { id: 3, warehouseId: 9 } });

    const result = await scene.service.lookup("org1", "user1", "A-01");

    expect(result).toMatchObject({ type: "location", locationId: 3, warehouseId: 9 });
  });
});

describe("barcode lookup — identity stays organisation-wide", () => {
  it("still resolves a SKU for a caller who holds only one warehouse", async () => {
    // Goods move between buildings. A picker holding a box that arrived on a
    // transfer must still have their own pick line match it, or PickConfirm
    // and PackagesService refuse the ordinary case.
    const scene = buildScene({ assigned: [7] });

    const result = await scene.service.lookup("org1", "user1", "W-001");

    expect(result).toMatchObject({ type: "variant", variantId: 5, sku: "W-001" });
  });

  it("still resolves a SKU for a caller assigned to no warehouse at all", async () => {
    // The strongest form: zero scope zeroes the quantity, and must not zero
    // the identity. A scan that answers "unknown product" because the operator
    // has no warehouse assignment is an outage, not a safety control.
    const scene = buildScene({ assigned: [] });

    const result = await scene.service.lookup("org1", "user1", "W-001");

    expect(result).toMatchObject({ type: "variant", variantId: 5, sku: "W-001" });
  });
});
