import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { RecallsService } from "../quality-recalls.service";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";

/**
 * `list` was scoped; reading one recall by id, and closing one, were not.
 *
 * `findOne` took no `userId` — the controller never passed one — and it hands
 * back MORE than the list does: every shipment the recalled lots went out on,
 * which is a customer list. `update` did take one and spent it only on the audit
 * row, so an operator holding one warehouse could CLOSE a recall raised against
 * stock in another, and closing a recall is what stops it being chased.
 *
 * The predicate is deliberately the LIST's, in one shared private method rather
 * than a second copy, because a second copy is how the two came apart in the
 * first place. `builds exactly the predicate the list builds` below is the case
 * that holds them together.
 */

function sqlText(statement: SQL): string {
  return new PgDialect().sqlToQuery(statement).sql;
}

/**
 * The `EXISTS (…)` block of a compiled predicate, for comparing list to detail.
 *
 * Placeholder NUMBERS are normalised away. The detail binds one parameter the
 * list does not — the recall id — so every `$n` inside its EXISTS is shifted by
 * one; comparing the raw text would fail on that alone and would say nothing
 * about whether the two predicates are the same predicate, which is the
 * question. The bound VALUES are checked separately by the cases above.
 */
function existsClause(text: string): string {
  const start = text.indexOf("EXISTS (");
  if (start === -1) return "";
  return text.slice(start).replace(/\$\d+/g, "$?");
}

function dbWith(rows: readonly unknown[]) {
  const wheres: SQL[] = [];
  const updates: SQL[] = [];
  let read = 0;
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "from", "innerJoin", "orderBy", "limit", "offset", "set"]) {
    chain[method] = () => chain;
  }
  chain["where"] = (statement: SQL) => {
    updates.push(statement);
    return chain;
  };
  chain["then"] = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
    Promise.resolve([{ count: 0 }]).then(resolve, reject);

  const db = {
    query: {
      invRecallEvents: {
        findFirst: (args: { where: SQL }) => {
          wheres.push(args.where);
          return Promise.resolve(rows[read++]);
        },
        findMany: (args: { where: SQL }) => {
          wheres.push(args.where);
          return Promise.resolve([]);
        },
      },
    },
    select: () => chain,
    update: () => chain,
  };
  return { db: db as never, wheres, updates };
}

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

function serviceWith(db: unknown, cache: unknown, scope: WarehouseScopeService): RecallsService {
  const stub = { insert: jest.fn(() => Promise.resolve()) } as never;
  return new RecallsService(db as never, cache as never, scope, stub, stub, stub, stub);
}

describe("one recall, read by id", () => {
  it("makes it unreachable for a caller holding no warehouse, and answers not found", async () => {
    /*
     * The PREDICATE is the assertion. This fixture answers with no recall
     * whichever way the service is written, so `rejects` alone would pass
     * against the unscoped code it was written to reject; an empty scope
     * compiles to `EXISTS (… AND FALSE)`, and that is what a real database acts
     * on. 404 not 403, per §4 — the alternative confirms the recall exists.
     */
    const { db, wheres } = dbWith([undefined]);
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([]);

    await expect(
      serviceWith(db, cache, scope).findOne("org-1", "nobody-1", 91),
    ).rejects.toBeInstanceOf(NotFoundException);

    const text = sqlText(wheres[0] as SQL);
    expect(text).toContain("EXISTS (");
    expect(text).toContain("FALSE");
  });

  it("narrows a scoped caller to recalls touching stock they hold, and excludes one touching none", async () => {
    /*
     * A recall names no warehouse of its own, so it is attributed INDIRECTLY:
     * through its lines' lots and variants, and those through the stock rows
     * sitting in the caller's locations.
     *
     * The NULL rule follows from that and is the opposite of the ASN detail's.
     * A plain `EXISTS` — asserted here, along with the absence of `NOT EXISTS`
     * or any `OR … IS NULL` escape — means a recall whose lines match no stock
     * row in the caller's warehouses is EXCLUDED, including a recall matching no
     * stock anywhere. On an ASN, a null warehouse means "not known yet" and the
     * row stays visible to everyone; here, no attribution means "touches
     * nothing you hold". Each detail follows its own aggregate.
     *
     * `rl.lot_id IS NULL AND sl.product_variant_id = …` inside the EXISTS is a
     * different thing entirely — it is how a line naming a variant rather than a
     * lot still finds its stock — so the assertion is on the OUTER shape.
     */
    const { db, wheres } = dbWith([undefined]);
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([7, 9]);

    await expect(
      serviceWith(db, cache, scope).findOne("org-1", "picker-1", 91),
    ).rejects.toBeInstanceOf(NotFoundException);

    const text = sqlText(wheres[0] as SQL);
    expect(text).toContain("sl.location_id IN (");
    expect(text).toContain("WHERE warehouse_id IN ($4, $5)");
    expect(text).not.toContain("NOT EXISTS");
    expect(text).not.toContain("OR rl.recall_id IS NULL");
  });

  it("consults the scope even for an org-wide reader, and then narrows nothing", async () => {
    // "No EXISTS" cannot on its own tell an unrestricted reader from an unscoped
    // method — which is the defect — so the absence is asserted alongside proof
    // that the scope was resolved at all.
    const { db, wheres } = dbWith([{ id: 91, orgId: "org-1", lines: [] }]);
    const { cache } = cacheWith();
    const { service: scope, consulted } = scopeOf(null);

    await serviceWith(db, cache, scope).findOne("org-1", "auditor-1", 91);

    expect(consulted).toHaveBeenCalledWith("org-1", "auditor-1");
    expect(sqlText(wheres[0] as SQL)).not.toContain("EXISTS");
  });

  it("builds exactly the predicate the list builds", async () => {
    /*
     * The drift guard, and the reason the EXISTS lives in one private method.
     * Two hand-copied predicates agreeing today is not the same as them being
     * the same predicate: the list gained its scope in INV-109 and the detail
     * was simply never told, so this compares the compiled text rather than
     * trusting that somebody will keep both in step.
     */
    const { service: scope } = scopeOf([7, 9]);

    const listDb = dbWith([]);
    const { cache: listCache } = cacheWith();
    await serviceWith(listDb.db, listCache, scope).list("org-1", "picker-1", {
      page: 1,
      limit: 20,
    } as never);

    const detailDb = dbWith([undefined]);
    const { cache: detailCache } = cacheWith();
    await expect(
      serviceWith(detailDb.db, detailCache, scope).findOne("org-1", "picker-1", 91),
    ).rejects.toBeInstanceOf(NotFoundException);

    const fromList = existsClause(sqlText(listDb.wheres[0] as SQL));
    const fromDetail = existsClause(sqlText(detailDb.wheres[0] as SQL));
    expect(fromList).not.toBe("");
    expect(fromDetail).toBe(fromList);
  });
});

describe("closing or renarrating a recall", () => {
  it("refuses one raised against stock the caller does not hold, and writes nothing", async () => {
    /*
     * Asserted on the predicate AND on no UPDATE having been issued. A version
     * that read the row, refused, and had already written would pass a
     * throw-only assertion; and the fixture returns no row either way, so the
     * throw proves nothing on its own.
     */
    const { db, wheres, updates } = dbWith([undefined]);
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([]);

    await expect(
      serviceWith(db, cache, scope).update("org-1", "nobody-1", 91, { status: "CLOSED" } as never),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(sqlText(wheres[0] as SQL)).toContain("FALSE");
    expect(updates).toHaveLength(0);
  });

  it("applies the list's own predicate for a scoped editor", async () => {
    const { db, wheres } = dbWith([undefined]);
    const { cache } = cacheWith();
    const { service: scope } = scopeOf([7]);

    await expect(
      serviceWith(db, cache, scope).update("org-1", "picker-1", 91, { status: "CLOSED" } as never),
    ).rejects.toBeInstanceOf(NotFoundException);

    const text = sqlText(wheres[0] as SQL);
    expect(text).toContain("EXISTS (");
    expect(text).toContain("WHERE warehouse_id IN ($4)");
  });
});

describe("the ungated read that is allowed to stay", () => {
  it("is a separate named private method, not a flag on the public one", () => {
    /*
     * `create` ends by handing back the recall it has just raised — and a recall
     * raised against lots that turn out to hold no stock in the raiser's
     * warehouses matches no EXISTS at all, so gating that tail would 404 an
     * operator against their own new record on exactly the recalls most worth
     * raising. Hence a named private read rather than a boolean on `findOne`
     * that a future route could be pointed at. Same shape as `loadAsnUnscoped`.
     */
    const service = readFileSync(join(__dirname, "..", "quality-recalls.service.ts"), "utf8");
    expect(service).toContain("private loadRecallUnscoped(orgId: string, id: number)");
    expect(service).toContain("return this.loadRecallUnscoped(orgId, executed.recall.id);");
    expect(service).toMatch(/async findOne\(orgId: string, userId: string, id: number\)/);

    const controller = readFileSync(join(__dirname, "..", "recalls.controller.ts"), "utf8");
    expect(controller).toContain("this.svc.findOne(u.orgId, u.userId, id)");
  });
});
