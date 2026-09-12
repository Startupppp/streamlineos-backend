import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { InvCycleCountsService } from "../inv-cycle-counts.service";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";

/**
 * `listCycleCounts` was scoped and everything reachable by id was not.
 *
 * The list resolves the caller's warehouses and gates on them. The detail read
 * and every mutation behind it — start, updateLines, review, post, cancel —
 * took no caller id at all, so they answered on `org_id` and the row id alone
 * even though the controller had `@CurrentUser()` in hand and passed only
 * `u.orgId`. A supervisor scoped to one building could read a count in another
 * whole, advance it, rewrite every variance on it, post those variances against
 * the real books, or cancel it outright.
 *
 * THE PREDICATE IS THE ASSERTION, NOT THE THROW. A mock answers empty whatever
 * the WHERE says, so "rejects with NotFoundException" passes against the
 * unscoped code too and proves nothing about scoping. What a real database acts
 * on is the compiled predicate, so that is what these read; the 404 is asserted
 * alongside it, in the same case, so the case still fails if the scope is
 * removed.
 */

const ORG = "org-1";
const USER = "supervisor-1";
const ID = 42;

function sqlText(statement: SQL): string {
  return new PgDialect().sqlToQuery(statement).sql;
}

function sqlParams(statement: SQL): unknown[] {
  // Bound values are read through the dialect. Reaching into `queryChunks`
  // instead gets a shape that changes between statements, and `JSON.stringify`
  // on a Drizzle SQL object throws outright — it holds a circular reference
  // back to its table.
  return new PgDialect().sqlToQuery(statement).params;
}

/** Every `findFirst` WHERE, in order. `wheres[0]` is always the gated read. */
function countsDb(row: unknown) {
  const wheres: SQL[] = [];
  const findFirst = jest.fn((args: { where: SQL }) => {
    wheres.push(args.where);
    return Promise.resolve(row);
  });
  const tx = {
    update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }),
  };
  const db = {
    query: {
      invCycleCounts: { findFirst },
      invCycleCountLines: { findMany: jest.fn(() => Promise.resolve([])) },
    },
    update: jest.fn(() => ({ set: () => ({ where: () => Promise.resolve(undefined) }) })),
    execute: jest.fn(() => Promise.resolve([])),
    transaction: jest.fn((run: (t: unknown) => Promise<unknown>) => run(tx)),
  };
  return { db, wheres };
}

/** A scope service answering with exactly these warehouses, or org-wide for `null`. */
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

function serviceWith(db: unknown, scope: WarehouseScopeService): InvCycleCountsService {
  const cache = { invalidate: jest.fn(), invalidateNamespace: jest.fn() };
  // Constructor order here is (db, cache, warehouseScope, engine, numSeq,
  // glBridge) — the audits service takes the same kind of arguments in a
  // different order, so they are not interchangeable.
  return new InvCycleCountsService(db as never, cache as never, scope, {} as never, {} as never, {} as never);
}

interface Reachable {
  name: string;
  /** The status the gate has to read back for this method to get past it. */
  status: string;
  invoke: (service: InvCycleCountsService) => Promise<unknown>;
}

/**
 * Every method that reaches one count by id. `post` is here too: it always took
 * a `userId`, but it reached the row through the same ungated `requireCount`,
 * so it was no better off than the five that took none.
 */
const REACHABLE: Reachable[] = [
  { name: "getCycleCount", status: "PLANNED", invoke: (s) => s.getCycleCount(ORG, USER, ID) },
  { name: "startCycleCount", status: "PLANNED", invoke: (s) => s.startCycleCount(ORG, USER, ID) },
  {
    name: "updateLines",
    status: "COUNTING",
    invoke: (s) => s.updateLines(ORG, USER, ID, { lines: [{ lineId: 1, countedQty: 5 }] }),
  },
  { name: "reviewCycleCount", status: "COUNTING", invoke: (s) => s.reviewCycleCount(ORG, USER, ID) },
  {
    name: "postCycleCount",
    status: "REVIEW",
    invoke: (s) => s.postCycleCount(ORG, USER, ID, "idem-1"),
  },
  { name: "cancelCycleCount", status: "PLANNED", invoke: (s) => s.cancelCycleCount(ORG, USER, ID) },
];

const rowWith = (status: string) => ({
  id: ID,
  status,
  countNumber: "CC-0001",
  warehouseId: 7,
  lines: [],
});

describe("one cycle count, reached by id", () => {
  it.each(REACHABLE)(
    "$name narrows a scoped caller to their own warehouses",
    async ({ status, invoke }) => {
      const { db, wheres } = countsDb(rowWith(status));
      const service = serviceWith(db, scopeOf([7, 9]).service);

      await invoke(service);

      // `IN` is uppercase because `warehousePredicate` builds a raw template;
      // `inArray` would have rendered a lowercase `in`. Read from the compiled
      // output rather than assumed.
      expect(sqlText(wheres[0] as SQL)).toContain('"inv_cycle_counts"."warehouse_id" IN ($3, $4)');
      expect(sqlParams(wheres[0] as SQL)).toEqual([ORG, ID, 7, 9]);
    },
  );

  it.each(REACHABLE)(
    "$name makes the count unreachable for a caller with no warehouse, and answers not found",
    async ({ invoke }) => {
      const { db, wheres } = countsDb(undefined);
      const service = serviceWith(db, scopeOf([]).service);

      await expect(invoke(service)).rejects.toBeInstanceOf(NotFoundException);
      // The throw alone would be vacuous — this fixture answers empty whatever
      // the WHERE says. `FALSE` is what a real database would act on, and it is
      // what `listCycleCounts` compiles an empty scope to. 404 rather than 403
      // is still worth pinning in the same case: a caller told "forbidden" has
      // learned the count exists, which is the oracle CLAUDE.md §4 bars.
      expect(sqlText(wheres[0] as SQL)).toContain("FALSE");
    },
  );

  it.each(REACHABLE)(
    "$name leaves an org-wide reader exactly as wide as they were",
    async ({ status, invoke }) => {
      const { db, wheres } = countsDb(rowWith(status));
      const { service: scope, consulted } = scopeOf(null);
      const service = serviceWith(db, scope);

      await invoke(service);

      // "No warehouse predicate" cannot on its own tell an UNRESTRICTED caller
      // apart from an UNSCOPED method — which is the bug — so the absence is
      // asserted alongside proof that the scope was resolved at all.
      expect(consulted).toHaveBeenCalledWith(ORG, USER);
      expect(sqlText(wheres[0] as SQL)).not.toContain('"warehouse_id"');
    },
  );
});

describe("the count a caller has just created", () => {
  it("is read back through a named unscoped method, not a flag on the public one", () => {
    /*
     * `createCycleCount` ends by returning the row it wrote, and the writer is
     * entitled to see what they wrote — gating that path would 404 a creator
     * against their own new count. The mutations do the same, having already
     * passed the scoped gate for that id. The unscoped read is therefore a
     * separate NAMED private method, so a future route cannot be pointed at it
     * by accident, which a boolean parameter would invite.
     */
    const source = readFileSync(join(__dirname, "..", "inv-cycle-counts.service.ts"), "utf8");
    expect(source).toContain("private async loadCycleCountUnscoped(");
    expect(source).toContain("return this.loadCycleCountUnscoped(orgId, cc.id);");
    // And the public reader still resolves a scope.
    expect(source).toMatch(/async getCycleCount\([^)]*userId: string[^)]*\)/);
  });

  it("refuses to open a count in a warehouse the caller does not hold", async () => {
    /*
     * The warehouse arrives in the body, so `create` is the one path where the
     * caller names the building rather than the row naming it. Ungated it
     * copies every stock level in that warehouse into the count lines and hands
     * them straight back — the detail-read disclosure, through the create.
     * `createWave` gates its own `input.warehouseId` the same way.
     */
    const { db } = countsDb(undefined);
    const service = serviceWith(db, scopeOf([9]).service);

    await expect(
      service.createCycleCount(ORG, USER, { warehouseId: 7 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
