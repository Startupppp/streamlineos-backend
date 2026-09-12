/**
 * Shared fixtures for cross-tenant isolation specs.
 *
 * Eight isolation specs each carried their own private copy of `makeDb` and
 * `sqlValues`. That is eight chances for one copy to drift into agreeing with a
 * bug — a `where` recorder that stops recording still lets every assertion pass,
 * because an assertion about a clause nobody captured is vacuous. One copy, used
 * by the specs written from here on.
 *
 * The existing eight are deliberately NOT migrated in the same change: they are
 * green today, and rewriting a passing isolation suite to prove a refactor is
 * how a suite quietly stops testing what it used to.
 */
import type { Db } from "../../../db/drizzle.module";

/**
 * Every scalar bound into a SQL expression tree, however deeply nested.
 *
 * Drizzle builds `where` as nested `SQL` objects whose leaves are `{ value }`
 * or further `queryChunks`. A test that stringifies the clause proves nothing —
 * the org id appears in the string whether or not it is bound to the right
 * column — so the assertion is that the ATTACKER's id is among the bound values
 * and the victim's is not.
 */
export function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown; where?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
    /**
     * `where` too, because Drizzle's relational API does not hand the predicate
     * over directly — `db.query.x.findFirst({ where, columns })` passes an
     * OPTIONS OBJECT, and descending only queryChunks/value stops at its
     * surface and returns nothing. Every service using the relational reader
     * therefore looked like it bound no org at all, which is a false NEGATIVE:
     * the test fails loudly, so it cost time rather than safety, but the same
     * blindness written the other way round (asserting `not.toContain(victim)`
     * alone) would have passed every one of them for the same reason.
     */
    ...(Object.prototype.hasOwnProperty.call(record, "where") ? sqlValues(record.where, seen) : []),
  ];
}

export interface IsolationDb {
  db: Db;
  findMany: jest.Mock;
  findFirst: jest.Mock;
  selectWhere: jest.Mock;
  execute: jest.Mock;
  /** Payloads passed to `insert().values(...)`. */
  insertValues: jest.Mock;
  /** Predicates passed to `update().set().where(...)` and `delete().where(...)`. */
  writeWhere: jest.Mock;
}

/**
 * A Drizzle double that answers `rows` to every read and records the `where`
 * clause it was given.
 *
 * It answers the SAME rows regardless of the org asked for — that is the point.
 * A service that filters correctly still receives the victim's row here, so the
 * test can only pass by asserting on the predicate the service built. A double
 * that returned [] for the wrong org would make every service look isolated,
 * including one that never mentions org_id.
 */
export function makeIsolationDb(rows: unknown[] = []): IsolationDb {
  const findMany = jest.fn().mockResolvedValue(rows);
  const findFirst = jest.fn().mockResolvedValue(rows[0] ?? null);
  const execute = jest.fn().mockResolvedValue(rows);
  const insertValues = jest.fn();
  const writeWhere = jest.fn();
  const handler = { findMany, findFirst };

  function makeChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    chain.orderBy = jest.fn().mockReturnValue(chain);
    chain.limit = jest.fn().mockReturnValue(chain);
    chain.offset = jest.fn().mockResolvedValue(rows);
    chain.groupBy = jest.fn().mockReturnValue(chain);
    chain.where = jest.fn().mockReturnValue(chain);
    chain.innerJoin = jest.fn().mockReturnValue(chain);
    chain.leftJoin = jest.fn().mockReturnValue(chain);
    chain.for = jest.fn().mockReturnValue(chain);
    chain.then = (
      onFulfilled: ((value: unknown) => unknown) | null | undefined,
      onRejected?: ((reason: unknown) => unknown) | null | undefined,
    ) => Promise.resolve(rows).then(onFulfilled ?? undefined, onRejected ?? undefined);
    return chain;
  }

  const rootChain = makeChain();
  const selectWhere = rootChain.where as jest.Mock;
  const selectFrom = jest.fn().mockReturnValue(rootChain);

  /**
   * The transaction handle is the SAME recorder as the outer db.
   *
   * It used to be `fn({})`. Any service whose work happens inside
   * `db.transaction(tx => ...)` — putaway completion, sync batches, pick
   * exceptions, most commands in this module — then ran against an empty object,
   * so the org predicate it built was recorded nowhere and an isolation test
   * asserting on it saw an empty array. That failure at least looked like a
   * failure; the dangerous version is the same test written to pass, which would
   * have certified isolation for a transaction nobody watched.
   */
  const db: Record<string, unknown> = {};
  Object.assign(db, {
    select: jest.fn().mockReturnValue({ from: selectFrom }),
    selectDistinct: jest.fn().mockReturnValue({ from: selectFrom }),
    query: new Proxy({} as Record<string, typeof handler>, { get: () => handler }),
    execute,
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation((w: unknown) => {
          writeWhere(w);
          return Object.assign(Promise.resolve(rows), {
            returning: jest.fn().mockResolvedValue(rows),
          });
        }),
        returning: jest.fn().mockResolvedValue(rows),
      }),
    }),
    /**
     * `insert().values(...)` is recorded, because for a whole class of commands
     * that IS the tenant scoping. `claimIdempotencyKey` stamps `orgId` into the
     * row it inserts and never puts it in a `where` at all, so a harness that
     * watched only predicates reported every idempotent command as unscoped.
     *
     * `.returning()` answers `rows` rather than `[]` for the same reason: an
     * empty return makes `claimIdempotencyKey` treat the claim as lost and take
     * the retry branch, so the command's real body — the part with the
     * org-scoped reads worth asserting on — never runs.
     */
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockImplementation((v: unknown) => {
        insertValues(v);
        const tail = {
          returning: jest.fn().mockResolvedValue(rows),
          onConflictDoNothing: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue(rows),
          }),
          onConflictDoUpdate: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue(rows),
          }),
        };
        return Object.assign(Promise.resolve(rows), tail);
      }),
    }),
    delete: jest.fn().mockReturnValue({
      where: jest.fn().mockImplementation((w: unknown) => {
        writeWhere(w);
        return Promise.resolve(rows);
      }),
    }),
  });

  return { db: db as unknown as Db, findMany, findFirst, selectWhere, execute, insertValues, writeWhere };
}

/**
 * Every caching entry point runs its producer straight through, so the service's
 * real query still executes and its predicate is still recorded.
 *
 * `cachedVersionedForOrg` is the one that matters and it was missing: a service
 * reading through it (InvOpsService.zoneBoard) died on "not a function" and, in
 * a test that tolerates throws, that reads as "bound no org" — a false negative
 * indistinguishable from a service with no tenant predicate at all.
 */
export const cacheStub = () => ({
  cached: jest.fn().mockImplementation(async (_k: string, fn: () => unknown) => fn()),
  cachedVersioned: jest.fn().mockImplementation(async (_ns: string, _h: string, fn: () => unknown) => fn()),
  cachedVersionedForOrg: jest
    .fn()
    .mockImplementation(async (_org: string, _ns: string, _h: string, fn: () => unknown) => fn()),
  cachedForOrg: jest
    .fn()
    .mockImplementation(async (_org: string, _k: string, fn: () => unknown) => fn()),
  cachedForOrgWith: jest
    .fn()
    .mockImplementation(async (_org: string, _k: string, _o: unknown, fn: () => unknown) => fn()),
  orgScopedKey: jest.fn().mockImplementation((org: string, key: string) => `${org}:${key}`),
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  del: jest.fn().mockResolvedValue(undefined),
  invalidate: jest.fn(),
  invalidateNamespace: jest.fn(),
  invalidateNamespaceForOrg: jest.fn(),
  invalidateForOrg: jest.fn(),
});

/** An unrestricted warehouse scope, so a leak cannot be masked by scoping. */
export const warehouseScopeStub = () => ({
  forUser: jest.fn().mockResolvedValue({
    key: "all",
    isEmpty: false,
    unrestricted: true,
    warehouse: () => ({ queryChunks: [] }),
    location: () => ({ queryChunks: [] }),
    anyOf: () => ({ queryChunks: [] }),
  }),
  scopeKey: jest.fn().mockReturnValue("all"),
  resolve: jest.fn().mockResolvedValue(null),
  locationPredicate: jest.fn().mockReturnValue({ queryChunks: [] }),
  warehousePredicate: jest.fn().mockReturnValue({ queryChunks: [] }),
  warehouseIdList: jest.fn().mockReturnValue(null),
  assertWarehouseVisible: jest.fn().mockResolvedValue(undefined),
  assertLocationVisible: jest.fn().mockResolvedValue(undefined),
});
