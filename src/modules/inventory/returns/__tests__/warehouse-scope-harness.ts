/**
 * Shared fixtures for the two return-scope suites.
 *
 * Not a `.spec.ts`, so jest does not collect it as a suite of its own — it is
 * imported by `customer-return-detail-scope.spec.ts` and its vendor twin, which
 * exercise the same defect against two different attribution rules and would
 * otherwise carry two copies of this that could drift apart.
 *
 * Three mocking notes, each of which cost a cycle elsewhere in this pass:
 *  - Bound values come from `PgDialect().sqlToQuery(statement).params`, never
 *    from poking at `queryChunks`.
 *  - `JSON.stringify` on a Drizzle SQL object throws: it holds a circular
 *    reference back to its table.
 *  - Case matters. `inArray` renders `in (…)` lowercase; a raw
 *    sql`${col} IN (…)` template renders `IN` uppercase. These predicates are
 *    raw templates, so the assertions say `IN`.
 */
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";

export function sqlText(statement: SQL): string {
  return new PgDialect().sqlToQuery(statement).sql;
}

/**
 * The scope-bearing part of a compiled predicate, with placeholder NUMBERS
 * normalised away.
 *
 * A detail read binds the row id before anything else, so every `$n` inside its
 * scope clause is shifted relative to the list's. Comparing raw text would fail
 * on that alone and would say nothing about whether the two are the same
 * predicate, which is the question these suites ask.
 */
export function scopeClause(text: string, table: string): string {
  // The scope clause is the last `and` argument, so it starts at the opening
  // paren of the OR group `anyOf` builds and runs to the end.
  const from = text.indexOf(`("${table}".`, text.indexOf(`"${table}"."org_id"`));
  if (from === -1) return "";
  return text.slice(from).replace(/\$\d+/g, "$?");
}

export function scopeOf(warehouseIds: number[] | null) {
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

export interface DbHarness {
  db: never;
  /** Every `where` a READ built, in order — RQB reads and select() chains alike. */
  wheres: SQL[];
  /** Every `where` a WRITE built. Empty means nothing was updated. */
  updates: SQL[];
  /** Records whether a mutation ever got as far as opening its transaction. */
  transaction: jest.Mock;
}

/**
 * `detail` answers the relational-query reads; `reads` answers the `select()`
 * chains in order (an absent entry answers the empty set).
 */
export function dbWith(opts: {
  detail?: unknown;
  reads?: readonly (readonly unknown[])[];
} = {}): DbHarness {
  const wheres: SQL[] = [];
  const updates: SQL[] = [];
  let read = 0;
  const reads = opts.reads ?? [];

  const readChain: Record<string, unknown> = {};
  for (const method of ["from", "innerJoin", "orderBy", "limit", "offset"]) {
    readChain[method] = () => readChain;
  }
  readChain["where"] = (statement: SQL) => {
    wheres.push(statement);
    return readChain;
  };
  readChain["then"] = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
    Promise.resolve(reads[read++] ?? []).then(resolve, reject);

  const writeChain: Record<string, unknown> = {};
  for (const method of ["set", "returning"]) writeChain[method] = () => writeChain;
  writeChain["where"] = (statement: SQL) => {
    updates.push(statement);
    return writeChain;
  };
  writeChain["then"] = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
    Promise.resolve([]).then(resolve, reject);

  const relational = {
    findFirst: (args: { where: SQL }) => {
      wheres.push(args.where);
      return Promise.resolve(opts.detail);
    },
    findMany: (args: { where: SQL }) => {
      wheres.push(args.where);
      return Promise.resolve([]);
    },
  };

  /*
   * A transaction mock that never runs its callback would silently void every
   * assertion inside it. These suites assert the callback is never REACHED, so
   * the mock runs it and lets it explode: a gate that failed to refuse produces
   * a loud error rather than a quiet pass.
   */
  const transaction = jest.fn((cb: (tx: unknown) => unknown) =>
    Promise.resolve(
      cb({
        execute: () => {
          throw new Error("the gate let this reach the locking statement");
        },
      }),
    ),
  );

  const db = {
    query: { invCustomerReturns: relational, invVendorReturns: relational },
    select: () => readChain,
    update: () => writeChain,
    insert: () => writeChain,
    transaction,
  };
  return { db: db as never, wheres, updates, transaction: transaction as jest.Mock };
}

export function cacheWith() {
  const keys: string[] = [];
  const cache = {
    cachedVersioned: (_ns: string, key: string, fetcher: () => Promise<unknown>) => {
      keys.push(key);
      return fetcher();
    },
    invalidateNamespace: jest.fn(() => Promise.resolve()),
    del: jest.fn(() => Promise.resolve()),
  };
  return { cache: cache as never, keys };
}
