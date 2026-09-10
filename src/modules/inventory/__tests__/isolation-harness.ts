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
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

export interface IsolationDb {
  db: Db;
  findMany: jest.Mock;
  findFirst: jest.Mock;
  selectWhere: jest.Mock;
  execute: jest.Mock;
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

  const db = {
    select: jest.fn().mockReturnValue({ from: selectFrom }),
    selectDistinct: jest.fn().mockReturnValue({ from: selectFrom }),
    query: new Proxy({} as Record<string, typeof handler>, { get: () => handler }),
    execute,
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([]),
        returning: jest.fn().mockResolvedValue([]),
      }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([]),
        onConflictDoNothing: jest.fn().mockResolvedValue([]),
        onConflictDoUpdate: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }),
      }),
    }),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
  } as unknown as Db;

  return { db, findMany, findFirst, selectWhere, execute };
}

export const cacheStub = () => ({
  cached: jest.fn().mockImplementation(async (_k: string, fn: () => unknown) => fn()),
  cachedVersioned: jest.fn().mockImplementation(async (_ns: string, _h: string, fn: () => unknown) => fn()),
  invalidate: jest.fn(),
  invalidateNamespace: jest.fn(),
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
