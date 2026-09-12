import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { KitService } from "../kit.service";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";

/**
 * "How many could I build" answered over stock the asker does not hold.
 *
 * `buildable` took no caller identity and an OPTIONAL `warehouseId` straight off
 * the query string. Omitting it summed component availability across every
 * warehouse in the organisation; supplying one read whichever building was
 * named. `assemble` beside it calls `assertLocationVisible` before it will move
 * anything, so the number and the action disagreed about who the caller was.
 *
 * Root CLAUDE.md §5: an optional filter that widens scope must be authorized,
 * and the gate must bite. There was no gate.
 */

const BOM = [{ componentVariantId: 11, quantityPer: "2.0000" }];

function dbWith(available: readonly unknown[]) {
  const executed: SQL[] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "from", "orderBy", "where", "innerJoin", "leftJoin"]) chain[m] = () => chain;
  chain["then"] = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
    Promise.resolve(BOM).then(resolve, reject);
  chain["execute"] = (statement: SQL) => {
    executed.push(statement);
    return Promise.resolve(available);
  };
  return { db: chain as never, executed };
}

function scopeOf(warehouseIds: number[] | null) {
  const consulted = jest.fn(() =>
    Promise.resolve(new Set(warehouseIds === null ? ["inventory:warehouses:scope-all"] : [])),
  );
  const service = new WarehouseScopeService(
    {
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve((warehouseIds ?? []).map((warehouseId) => ({ warehouseId }))),
        }),
      }),
    } as never,
    { resolveUserPermissions: consulted } as never,
  );
  return { service, consulted };
}

function serviceWith(db: unknown, scope: WarehouseScopeService): KitService {
  const stub = {} as never;
  return new KitService(db as never, stub, stub, scope);
}

const sqlText = (statement: SQL): string => new PgDialect().sqlToQuery(statement).sql;

describe("how many of this kit could be built", () => {
  it("refuses a warehouse the caller does not hold, as not found", async () => {
    // 404 rather than 403: naming somebody else's warehouse must not confirm it
    // exists.
    const { db } = dbWith([]);
    const { service: scope } = scopeOf([7]);
    const service = serviceWith(db, scope);

    await expect(service.buildable("org-1", "keeper-1", 3, 9)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("narrows an OMITTED warehouse to the caller's own, rather than the whole organisation", async () => {
    /*
     * The half that matters. A missing filter used to mean "everywhere", which
     * is the shape this defect class keeps taking: the default widens.
     */
    const { db, executed } = dbWith([{ product_variant_id: 11, available: "10.0000" }]);
    const { service: scope } = scopeOf([7, 9]);
    const service = serviceWith(db, scope);

    await service.buildable("org-1", "keeper-1", 3);

    expect(executed).toHaveLength(1);
    expect(sqlText(executed[0] as SQL)).toContain("loc.warehouse_id IN (");
  });

  it("answers zero for a caller holding no warehouse, without asking for stock", async () => {
    /*
     * The PREDICATE, or in this case the absence of a query, is the assertion —
     * a fixture returns the same rows whatever the SQL says, so "it returned 0"
     * would pass against the unscoped code too.
     */
    const { db, executed } = dbWith([{ product_variant_id: 11, available: "999.0000" }]);
    const { service: scope } = scopeOf([]);
    const service = serviceWith(db, scope);

    await expect(service.buildable("org-1", "nobody-1", 3)).resolves.toBe("0");
    expect(executed).toHaveLength(0);
  });

  it("consults the scope for an org-wide reader too, then sums across everything", async () => {
    /*
     * "No warehouse clause" cannot on its own tell an UNRESTRICTED reader from
     * a method that never asked — which is the bug — so the absence is asserted
     * beside proof that the scope was resolved. Without the spy, reverting the
     * fix left this case green.
     */
    const { db, executed } = dbWith([{ product_variant_id: 11, available: "10.0000" }]);
    const { service: scope, consulted } = scopeOf(null);
    const service = serviceWith(db, scope);

    await service.buildable("org-1", "auditor-1", 3);

    expect(consulted).toHaveBeenCalledWith("org-1", "auditor-1");
    expect(sqlText(executed[0] as SQL)).not.toContain("loc.warehouse_id IN (");
  });

  it("still narrows to one warehouse when the caller holds it", async () => {
    const { db, executed } = dbWith([{ product_variant_id: 11, available: "10.0000" }]);
    const { service: scope } = scopeOf([7]);
    const service = serviceWith(db, scope);

    await service.buildable("org-1", "keeper-1", 3, 7);

    expect(sqlText(executed[0] as SQL)).toContain("loc.warehouse_id =");
  });
});
