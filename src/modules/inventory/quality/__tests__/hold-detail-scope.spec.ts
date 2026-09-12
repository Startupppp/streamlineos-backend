import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { HoldsService } from "../quality-holds.service";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";

/**
 * `list` was scoped, and reading or releasing one hold by id was not.
 *
 * The list resolves the caller's warehouses and gates on the bin the hold names;
 * `findOne` took no `userId` at all — the controller never passed one — so it
 * answered on `org_id` and the hold id. `release` had `userId` in hand and spent
 * it only on the engine call, which meant the status read in front of the engine
 * was an oracle, and a hold naming no bin could be released for real once the
 * fallback happened to pick a location the caller did hold.
 *
 * The cached read is the sharp one, and not for the reason it first looks.
 * Adding the predicate WITHOUT putting the scope in the cache key would have
 * been worse than leaving it alone: the first caller's narrowed answer would sit
 * under `detail:<id>` and be handed to the next, defeating the filter in both
 * directions. `keys the cached detail by the scope` below is the only case here
 * that catches that, and a suite that only checked the predicate would sail past
 * it.
 */

function sqlText(statement: SQL): string {
  return new PgDialect().sqlToQuery(statement).sql;
}

/** Records every `where` the service builds, and answers whatever it is given. */
function dbWith(rows: readonly unknown[]) {
  const wheres: SQL[] = [];
  let call = 0;
  const db = {
    query: {
      invQualityHolds: {
        findFirst: (args: { where: SQL }) => {
          wheres.push(args.where);
          return Promise.resolve(rows[call++]);
        },
      },
    },
  };
  return { db: db as never, wheres };
}

/** Records every cache key, and always runs the fetcher so the query is built. */
function cacheWith() {
  const keys: string[] = [];
  const cache = {
    cachedVersioned: (_ns: string, key: string, fetcher: () => Promise<unknown>) => {
      keys.push(key);
      return fetcher();
    },
    invalidateNamespace: jest.fn(() => Promise.resolve()),
  };
  return { cache: cache as never, keys };
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

function serviceWith(
  db: unknown,
  cache: unknown,
  scope: WarehouseScopeService,
  engine: unknown = {},
): HoldsService {
  return new HoldsService(db as never, cache as never, scope, engine as never, {} as never);
}

describe("one quality hold, read by id", () => {
  it("makes it unreachable for a caller holding no warehouse, and answers not found", async () => {
    /*
     * The PREDICATE is the assertion, not the throw. This fixture answers with
     * no row whichever way the service is written, so `rejects` on its own would
     * pass against the unscoped code it was written to reject. What a real
     * database acts on is the `FALSE` an empty scope compiles to.
     *
     * 404 rather than 403 is worth pinning too: a caller told "forbidden" has
     * been told the hold exists, which is the existence oracle CLAUDE.md §4 bars.
     */
    const { db, wheres } = dbWith([undefined]);
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([]);

    await expect(
      serviceWith(db, cache, scope).findOne("org-1", "nobody-1", 42),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(sqlText(wheres[0] as SQL)).toContain("FALSE");
  });

  it("narrows a scoped caller to bins in their own warehouses, and excludes a hold with no bin", async () => {
    /*
     * `location_id IN (SELECT id FROM inv_locations WHERE warehouse_id IN (…))`
     * — the LIST's predicate, character for character, because it is now the
     * same expression.
     *
     * The NULL rule is the half worth stating. A hold with a NULL `location_id`
     * makes this `NULL IN (…)`, which is NULL, which is not true: an
     * unattributed hold is INVISIBLE to a scoped operator. That is deliberately
     * the opposite of the ASN detail, where `warehouse_id IS NULL OR …` keeps
     * unattributed rows visible to everyone. An ASN header names its warehouse
     * nullably because it may not be known yet; a hold without a bin is a hold
     * standing nowhere. Each detail follows its own aggregate — so the absence
     * of an `IS NULL` escape is asserted, not merely left out.
     */
    const { db, wheres } = dbWith([undefined]);
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([7, 9]);

    await expect(
      serviceWith(db, cache, scope).findOne("org-1", "picker-1", 42),
    ).rejects.toBeInstanceOf(NotFoundException);

    const text = sqlText(wheres[0] as SQL);
    expect(text).toContain('"inv_quality_holds"."location_id" IN (');
    expect(text).toContain("WHERE warehouse_id IN ($3, $4)");
    expect(text).not.toContain("IS NULL");
  });

  it("consults the scope even for an org-wide reader, and then narrows nothing", async () => {
    /*
     * "No warehouse predicate" cannot on its own tell an UNRESTRICTED reader
     * apart from an UNSCOPED method — which is the defect — so the absence is
     * asserted alongside proof that the scope was resolved at all.
     */
    const { db, wheres } = dbWith([{ id: 42, orgId: "org-1" }]);
    const { cache } = cacheWith();
    const { service: scope, consulted } = scopeOf(null);

    await serviceWith(db, cache, scope).findOne("org-1", "auditor-1", 42);

    expect(consulted).toHaveBeenCalledWith("org-1", "auditor-1");
    expect(sqlText(wheres[0] as SQL)).not.toContain("inv_locations");
  });

  it("keys the cached detail by the scope, so one caller's answer is not served to the next", async () => {
    /*
     * CLAUDE.md §6, and the trap this whole fix walks into if it is half done.
     * The same hold id read by three different callers must produce three
     * different cache keys; if it did not, the narrowed row the picker is
     * allowed to see would be stored under `detail:42` and handed straight to
     * the auditor, and the auditor's full row handed back to the picker.
     *
     * Asserting on the KEYS rather than on the predicate is the point: a version
     * of this fix with a perfect WHERE clause and the old key passes every other
     * case in this file and fails only here.
     */
    const { cache, keys } = cacheWith();

    for (const [warehouses, user] of [
      [[7], "picker-1"],
      [[9], "other-picker-1"],
      [null, "auditor-1"],
    ] as [number[] | null, string][]) {
      const { db } = dbWith([{ id: 42, orgId: "org-1" }]);
      const { service: scope } = scopeOf(warehouses);
      await serviceWith(db, cache, scope).findOne("org-1", user, 42);
    }

    expect(keys).toEqual(["detail:7:42", "detail:9:42", "detail:all:42"]);
    expect(new Set(keys).size).toBe(3);
  });
});

describe("releasing one quality hold", () => {
  it("refuses a hold outside the caller's warehouses before the engine is ever asked", async () => {
    /*
     * The gate has to sit on the READ. `engine.execute` does refuse movements
     * into a warehouse the caller does not hold, but only after this method has
     * already told the caller whether the hold exists and what state it is in —
     * and where a hold names no bin, `release` falls back to whichever location
     * in the ORG holds that variant, so picking one inside the caller's own
     * warehouses got the engine's blessing for a hold they cannot see.
     *
     * Asserted on the compiled predicate plus the engine never being called:
     * "rejects with NotFoundException" alone would pass against the version that
     * read the row first and refused afterwards.
     */
    const { db, wheres } = dbWith([undefined]);
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([]);
    const execute = jest.fn();

    await expect(
      serviceWith(db, cache, scope, { execute }).release("org-1", "nobody-1", 42, "key-1"),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(sqlText(wheres[0] as SQL)).toContain("FALSE");
    expect(execute).not.toHaveBeenCalled();
  });

  it("applies the list's own predicate for a scoped releaser", async () => {
    const { db, wheres } = dbWith([undefined]);
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([7]);
    const execute = jest.fn();

    await expect(
      serviceWith(db, cache, scope, { execute }).release("org-1", "picker-1", 42, "key-1"),
    ).rejects.toBeInstanceOf(NotFoundException);

    const text = sqlText(wheres[0] as SQL);
    expect(text).toContain('"inv_quality_holds"."location_id" IN (');
    expect(text).toContain("WHERE warehouse_id IN ($3)");
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("the ungated read that is allowed to stay", () => {
  it("is a separate named private method, not a flag on the public one", () => {
    /*
     * `create` ends by handing back the hold it has just written, and gating
     * that would 404 an operator against their own new record. So the unscoped
     * read is `loadHoldUnscoped` — named, private, and reachable only from the
     * two call sites entitled to it — rather than a boolean on `findOne` that a
     * future route could be pointed at by accident. Same shape as the ASN fix.
     */
    const service = readFileSync(join(__dirname, "..", "quality-holds.service.ts"), "utf8");
    expect(service).toContain("private loadHoldUnscoped(orgId: string, holdId: number)");
    expect(service).toMatch(/async findOne\(orgId: string, userId: string, holdId: number\)/);

    // And the controller actually passes the caller through, which is the half
    // the census could not see: a scoped service method reached by a controller
    // that still sends only `orgId` would not compile, but one that sent a
    // hard-coded id would.
    const controller = readFileSync(join(__dirname, "..", "holds.controller.ts"), "utf8");
    expect(controller).toContain("this.svc.findOne(u.orgId, u.userId, holdId)");
  });
});
