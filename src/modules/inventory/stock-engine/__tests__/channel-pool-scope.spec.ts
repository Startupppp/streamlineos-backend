import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { ChannelPoolService } from "../channel-pool.service";
import { WarehouseScopeService } from "../warehouse-scope.service";

/**
 * Channel availability summed the whole estate when no warehouse was named.
 *
 * `listForChannel` in the same service resolves the caller's warehouses and
 * filters on them. `listForVariant` and `availabilityFor` beside it took no
 * caller at all, and `availabilityFor`'s warehouse is OPTIONAL: omit it and the
 * gate compiled to `TRUE`, so the answer covered every building.
 *
 * A default that widens is the half of this class that reads as correct — the
 * explicit parameter looks like the whole surface, and it is the missing one
 * that opens the estate. Same shape as `KitService.buildable`.
 *
 * `availability` itself stays unscoped by default on purpose: `assertPromisable`
 * calls it to decide whether the ORGANISATION can promise these units, which is
 * a different question from whether the requester may look at them.
 */

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
  service.assertWarehouseVisible = jest.fn(
    async (_orgId: string, _userId: string, _warehouseId: number | null | undefined) => {},
  );
  return Object.assign(service, { consulted });
}

function serviceWith(executed: SQL[], scope: WarehouseScopeService): ChannelPoolService {
  const db = {
    execute: (statement: SQL) => {
      executed.push(statement);
      return Promise.resolve([{ available: "0" }]);
    },
  } as never;
  return new ChannelPoolService(db, {} as never, scope);
}

const sqlText = (statement: SQL): string => new PgDialect().sqlToQuery(statement).sql;

describe("channel availability and the caller's warehouses", () => {
  it("narrows an OMITTED warehouse to the caller's own, not the whole estate", async () => {
    const executed: SQL[] = [];
    const service = serviceWith(executed, scopeOf([7, 9]));

    await service.availabilityFor("org-1", "seller-1", { productVariantId: 11 });

    expect(sqlText(executed[0] as SQL)).toContain("loc.warehouse_id IN (");
  });

  it("answers over nothing for a caller holding no warehouse", async () => {
    const executed: SQL[] = [];
    const service = serviceWith(executed, scopeOf([]));

    await service.availabilityFor("org-1", "nobody-1", { productVariantId: 11 });

    expect(sqlText(executed[0] as SQL)).toContain("FALSE");
  });

  it("consults the scope for an org-wide reader too, then sums everything", async () => {
    /*
     * `TRUE` in the gate cannot on its own tell an UNRESTRICTED reader from a
     * method that never asked — which is the bug — so the width is asserted
     * beside proof that the scope was resolved. Without this, reverting the fix
     * left the case green.
     */
    const executed: SQL[] = [];
    const scope = scopeOf(null);
    const service = serviceWith(executed, scope);

    await service.availabilityFor("org-1", "auditor-1", { productVariantId: 11 });

    expect(scope.consulted).toHaveBeenCalledWith("org-1", "auditor-1");
    expect(sqlText(executed[0] as SQL)).toContain("TRUE");
  });

  it("asserts a NAMED warehouse rather than filtering it away", async () => {
    // Naming a building you do not hold must refuse, not quietly return zero:
    // a zero reads as "no stock" and is a different answer from "not yours".
    const scope = scopeOf([7]);
    const service = serviceWith([], scope);

    await service.availabilityFor("org-1", "seller-1", { productVariantId: 11, warehouseId: 9 });

    expect(scope.assertWarehouseVisible).toHaveBeenCalledWith("org-1", "seller-1", 9);
  });

  it("leaves the promise path unscoped, because it asks a different question", () => {
    /*
     * `assertPromisable` decides whether the organisation can promise these
     * units. Scoping it would make a marketplace order refusable because the
     * SYSTEM USER behind it holds no warehouse, which is not an access question
     * at all.
     */
    const source = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "..", "channel-pool.service.ts"),
      "utf8",
    ) as string;
    expect(source).toContain("scope?: number[] | null;");
    expect(source).toMatch(/scope === undefined \|\| scope === null/);
  });
});
