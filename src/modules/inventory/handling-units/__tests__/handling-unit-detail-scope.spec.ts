import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { HandlingUnitService } from "../handling-unit.service";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";

/**
 * `list` narrowed to the caller's warehouses; `detail` behind it did not.
 *
 * It took no `userId` — the controller never passed one — so a keeper holding
 * one building could read any pallet in the organisation by id. What `detail`
 * answers with is not a summary: it returns the unit's whole subtree and its
 * ROLLED-UP CONTENTS, which is the stock standing on that pallet.
 *
 * Fourth instance of this shape found in inventory, after the labour records,
 * the ASN detail and the re-slot approval.
 */

const UNIT = {
  id: 3,
  huCode: "PAL-0003",
  kind: "PALLET",
  status: "OPEN",
  locationId: 55,
  parentHuId: null,
};

function dbWith(unitRows: readonly unknown[]) {
  const wheres: SQL[] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "from", "orderBy", "limit"]) chain[m] = () => chain;
  chain["where"] = (statement: SQL) => {
    wheres.push(statement);
    return chain;
  };
  let call = 0;
  chain["then"] = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
    Promise.resolve(call++ === 0 ? unitRows : []).then(resolve, reject);
  chain["execute"] = () => Promise.resolve([]);
  return { db: chain as never, wheres };
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

function serviceWith(db: unknown, scope: WarehouseScopeService): HandlingUnitService {
  const stub = {} as never;
  return new HandlingUnitService(db as never, stub, stub, stub, scope);
}

function sqlText(statement: SQL): string {
  return new PgDialect().sqlToQuery(statement).sql;
}

describe("reading one handling unit", () => {
  it("narrows a scoped caller with the same predicate the list uses", async () => {
    const { db, wheres } = dbWith([UNIT]);
    const { service: scope } = scopeOf([7, 9]);
    const service = serviceWith(db, scope);

    await service.detail("org-1", "keeper-1", 3);

    /*
     * The PREDICATE is the assertion, not the outcome. A fixture answers the
     * same rows whatever the WHERE says, so "it returned nothing" would pass
     * against the unscoped code too — that has caught three of my own tests
     * today.
     */
    const text = sqlText(wheres[0] as SQL);
    expect(text).toContain('"location_id" IS NULL OR EXISTS');
    expect(text).toContain("l.warehouse_id IN (");
  });

  it("keeps a unit that is not anywhere yet visible, matching the list", async () => {
    // This table's rule, not a house rule: an HU is built before it is put
    // anywhere, and hiding one from the person who has just made it would be
    // worse than the leak this closes. The labour records take the opposite
    // view of an unattributed row, which is why each detail follows its own
    // aggregate.
    const { db, wheres } = dbWith([UNIT]);
    const { service: scope } = scopeOf([7]);
    const service = serviceWith(db, scope);

    await service.detail("org-1", "keeper-1", 3);

    expect(sqlText(wheres[0] as SQL)).toContain("IS NULL OR EXISTS");
  });

  it("makes every unit unreachable for a caller holding no warehouse", async () => {
    const { db, wheres } = dbWith([]);
    const { service: scope } = scopeOf([]);
    const service = serviceWith(db, scope);

    await expect(service.detail("org-1", "nobody-1", 3)).rejects.toBeInstanceOf(NotFoundException);
    expect(sqlText(wheres[0] as SQL)).toContain("FALSE");
  });

  it("consults the scope even for an org-wide reader, and then adds nothing", async () => {
    /*
     * "No warehouse predicate" cannot on its own tell an UNRESTRICTED reader
     * from an UNSCOPED method — which is the bug — so the absence is asserted
     * beside proof that the scope was resolved at all. Without this, reverting
     * the fix left this case green.
     */
    const { db, wheres } = dbWith([UNIT]);
    const { service: scope, consulted } = scopeOf(null);
    const service = serviceWith(db, scope);

    await service.detail("org-1", "auditor-1", 3);

    expect(consulted).toHaveBeenCalledWith("org-1", "auditor-1");
    expect(sqlText(wheres[0] as SQL)).not.toContain("warehouse_id");
  });

  it("uses one definition of visibility for both the list and the detail", () => {
    /*
     * A second, subtly different copy of that predicate is how a list and the
     * detail behind it start disagreeing about which pallets exist, so both
     * read `scopePredicate`. Asserted against the source because the claim is
     * about there being ONE of it.
     */
    const source = readFileSync(join(__dirname, "..", "handling-unit.service.ts"), "utf8");
    expect(source.match(/IS NULL OR EXISTS/g) ?? []).toHaveLength(1);
    expect(source).toContain("private scopePredicate(");
  });

  it("does not gate the read that hands back a unit just created or moved", () => {
    // `create` and `move` have already called `assertLocationVisible`, so the
    // caller's standing is settled; gating again would refuse an operator the
    // pallet they have just built. Named, never a boolean flag, so a route
    // cannot be pointed at it by accident.
    const source = readFileSync(join(__dirname, "..", "handling-unit.service.ts"), "utf8");
    expect(source).toContain("private async detailUnscoped(");
    expect(source.match(/this\.detailUnscoped\(/g) ?? []).toHaveLength(2);
  });
});
