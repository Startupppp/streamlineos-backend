/**
 * Shared fixtures for the inventory warehouse-scope suites.
 *
 * Not a `.spec.ts`, so jest does not collect it as a suite of its own. It lived
 * under `returns/__tests__` while only the two return suites used it; the stock
 * module's release gate needs the same fixtures, and a helper two sub-modules
 * import does not belong inside one of them.
 *
 * Every suite that uses it exercises the same defect against a different
 * attribution rule, and would otherwise carry its own copy of this that could
 * drift apart.
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
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";

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
  /**
   * Every row set an INSERT was handed, in order. Empty means nothing was
   * written — which is the assertion a create-side gate needs, because a
   * service that inserted the rows and refused afterwards would still satisfy a
   * `rejects` on its own.
   */
  inserts: unknown[];
  /** Records whether a mutation ever got as far as opening its transaction. */
  transaction: jest.Mock;
}

/**
 * The tables these services read through the relational query builder.
 *
 * The scoped aggregates themselves, plus the source documents a create
 * validates on its way in. Listed rather than proxied so an unlisted table
 * fails loudly as "cannot read properties of undefined" instead of quietly
 * answering nothing — which is how the reservations list announced itself when
 * this harness moved up here.
 */
const RQB_TABLES = [
  "invCustomerReturns",
  "invVendorReturns",
  "invSalesOrders",
  "invShipments",
  "invVendors",
  "invPurchaseOrders",
  "invGrns",
  "invStockReservations",
  "invStockAdjustments",
  "invLots",
  "invStockTransactions",
  "invStockTransfers",
  "invSerialNumbers",
] as const;

/**
 * `detail` answers the relational-query reads; `rows` overrides it per table,
 * which is what a create needs — its org-existence checks must ANSWER before
 * the scope gate behind them is ever reached. `reads` answers the `select()`
 * chains in order (an absent entry answers the empty set), and `inserted` is
 * what an insert's `returning()` hands back.
 */
export function dbWith(opts: {
  detail?: unknown;
  rows?: Readonly<Record<string, unknown>>;
  reads?: readonly (readonly unknown[])[];
  inserted?: readonly unknown[];
} = {}): DbHarness {
  const wheres: SQL[] = [];
  const updates: SQL[] = [];
  const inserts: unknown[] = [];
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

  // Its own chain rather than a third role for `writeChain`: an insert is the
  // one write these suites need to observe the PAYLOAD of, and `returning()`
  // has to hand back a row or the create's own tail read dereferences undefined.
  const insertChain: Record<string, unknown> = {};
  insertChain["values"] = (rowsInserted: unknown) => {
    inserts.push(rowsInserted);
    return insertChain;
  };
  insertChain["returning"] = () => insertChain;
  insertChain["then"] = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
    Promise.resolve(opts.inserted ?? []).then(resolve, reject);

  const relationalFor = (table: string) => ({
    findFirst: (args: { where: SQL }) => {
      wheres.push(args.where);
      return Promise.resolve(
        opts.rows && table in opts.rows ? opts.rows[table] : opts.detail,
      );
    },
    findMany: (args: { where: SQL }) => {
      wheres.push(args.where);
      return Promise.resolve([]);
    },
  });

  /*
   * A transaction mock that never runs its callback would silently void every
   * assertion inside it. These suites assert the callback is never REACHED, so
   * the mock runs it and lets it explode: a gate that failed to refuse produces
   * a loud error rather than a quiet pass.
   */
  const transaction = jest.fn((cb: (tx: unknown) => unknown) =>
    Promise.resolve(
      cb({
        /*
          A gate may legitimately run INSIDE the transaction --
          `assertLocationsInScope` takes a `tx` by design, so a create that
          validates its claimed locations before writing has to be able to read
          through this handle. It answers from the same `reads` queue as the
          top-level chain, so a suite decides what it finds.
        */
        select: () => readChain,
        execute: () => {
          throw new Error("the gate let this reach the locking statement");
        },
      }),
    ),
  );

  const query: Record<string, unknown> = {};
  for (const table of RQB_TABLES) query[table] = relationalFor(table);

  const db = {
    query,
    select: () => readChain,
    update: () => writeChain,
    insert: () => insertChain,
    transaction,
  };
  return {
    db: db as never,
    wheres,
    updates,
    inserts,
    transaction: transaction as jest.Mock,
  };
}

export function cacheWith() {
  const keys: string[] = [];
  const cache = {
    cachedVersioned: (_ns: string, key: string, fetcher: () => Promise<unknown>) => {
      keys.push(key);
      return fetcher();
    },
    invalidateNamespace: jest.fn(() => Promise.resolve()),
    /* The adjustments service busts single keys as well as namespaces. */
    invalidate: jest.fn(() => Promise.resolve()),
    /*
     * The *ForOrg family is a separate counter, not an alias, and the stock
     * report invalidation bumps `inv:ops:*` through it. Omitting it here threw
     * "not a function" out of a cancel that had already updated the row — which
     * a scope test reads as a refusal, the exact inverse of what it asserts.
     */
    invalidateNamespaceForOrg: jest.fn(() => Promise.resolve()),
    del: jest.fn(() => Promise.resolve()),
  };
  return { cache: cache as never, keys };
}
