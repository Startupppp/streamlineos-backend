import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { LaborService } from "../labor.service";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";

/**
 * The aggregate was scoped and the drill-down behind it was not.
 *
 * `board()` resolves `warehouseScope.forUser` and says so in its own comment —
 * "a supervisor scoped to no warehouse sees nobody, not everybody". `recentFor`,
 * which is the per-person detail behind that same board, took `userId` straight
 * off the query string and filtered on `org_id` and that id alone. The caller's
 * identity never reached it.
 *
 * That is the worse way round to get it wrong. The board returns totals; this
 * returns a named colleague's individual work — every task, when they started
 * and finished it, units, scans and bin changes. Any holder of
 * `inventory:labor:read` could read anyone, in any warehouse, including a user
 * the board deliberately shows nothing at all.
 */

function chainDb(rows: readonly unknown[]) {
  const wheres: SQL[] = [];
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "from", "orderBy", "limit"]) chain[method] = () => chain;
  chain["where"] = (statement: SQL) => {
    wheres.push(statement);
    return chain;
  };
  chain["then"] = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return { db: chain as never, wheres };
}

/** A scope service answering with exactly the warehouses given, or org-wide for `null`. */
function scopeOf(warehouseIds: number[] | null) {
  return new WarehouseScopeService(
    {
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve((warehouseIds ?? []).map((warehouseId) => ({ warehouseId }))),
        }),
      }),
    } as never,
    {
      resolveUserPermissions: () =>
        Promise.resolve(new Set(warehouseIds === null ? ["inventory:warehouses:scope-all"] : [])),
    } as never,
  );
}

function sqlText(statement: SQL): string {
  return new PgDialect().sqlToQuery(statement).sql;
}

describe("one person's labour records", () => {
  it("answers a caller with no warehouse with nothing, without asking the database", async () => {
    const { db, wheres } = chainDb([{ id: 1 }]);
    const service = new LaborService(db, scopeOf([]));

    await expect(service.recentFor("org-1", "supervisor-1", "picker-1", 50)).resolves.toEqual([]);
    /*
     * Not just an empty array — the query must never be built. An implementation
     * that ran the read and filtered the rows afterwards would pass a
     * `toEqual([])` assertion while still having fetched somebody else's work.
     */
    expect(wheres).toHaveLength(0);
  });

  it("narrows a scoped caller to their own warehouses", async () => {
    const { db, wheres } = chainDb([]);
    const service = new LaborService(db, scopeOf([7, 9]));

    await service.recentFor("org-1", "supervisor-1", "picker-1", 50);

    expect(wheres).toHaveLength(1);
    const text = sqlText(wheres[0] as SQL);
    expect(text).toContain('"warehouse_id" IN ($3, $4)');
    expect(text).toContain('"user_id" = $2');
    expect(text).toContain('"org_id" = $1');
  });

  it("leaves an org-wide reader exactly as wide as they were", async () => {
    // The fix must not take anything away from somebody who already held
    // `inventory:warehouses:scope-all`; for them the predicate is TRUE.
    const { db, wheres } = chainDb([]);
    const service = new LaborService(db, scopeOf(null));

    await service.recentFor("org-1", "auditor-1", "picker-1", 50);

    expect(wheres).toHaveLength(1);
    const text = sqlText(wheres[0] as SQL);
    expect(text).toContain("TRUE");
    expect(text).not.toContain('"warehouse_id" IN (');
  });

  it("gates the detail on the same column the board gates on", () => {
    /*
     * The board filters `lr.warehouse_id`, so the detail does too — rather than
     * `anyOf(warehouse, location)`, which would surface rows the aggregate above
     * never counted. Asserted against the source because the claim is about
     * which column each query names, and both are hand-written SQL in one file.
     */
    const source = readFileSync(join(__dirname, "..", "labor.service.ts"), "utf8");
    expect(source).toContain("scope.warehouse(sql`lr.warehouse_id`)");
    expect(source).toContain("scope.warehouse(sql`${invLaborRecords.warehouseId}`)");
    // `.anyOf(` with the dot: the prose above this method names `anyOf` when it
    // explains why it is not used, and matching that would be self-referential.
    expect(source).not.toContain(".anyOf(");
  });
});
