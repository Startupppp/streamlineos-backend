import type { Db } from "../../../../db/drizzle.module";

export interface Op {
  kind: "select" | "insert" | "update" | "delete";
  table: unknown;
  where?: unknown;
  values?: unknown;
  set?: unknown;
  conflict?: unknown;
  orderBy: unknown[];
}

export type Resolver = (op: Op) => unknown[];

export function makeDb(resolve: Resolver, ops: Op[]): Db {
  const chain = (op: Op) => {
    const api: Record<string, unknown> = {};
    const same = () => api;
    for (const key of ["innerJoin", "leftJoin", "limit", "groupBy", "returning"]) {
      api[key] = jest.fn(same);
    }
    api.from = jest.fn((table: unknown) => {
      op.table = table;
      return api;
    });
    api.where = jest.fn((where: unknown) => {
      op.where = where;
      return api;
    });
    api.values = jest.fn((values: unknown) => {
      op.values = values;
      return api;
    });
    api.set = jest.fn((set: unknown) => {
      op.set = set;
      return api;
    });
    api.onConflictDoNothing = jest.fn((conflict: unknown) => {
      op.conflict = conflict;
      return api;
    });
    api.orderBy = jest.fn((...order: unknown[]) => {
      op.orderBy.push(...order);
      return api;
    });
    const settle = () => Promise.resolve(resolve(op));
    api.then = (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
      settle().then(onOk, onErr);
    api.catch = (onErr: (e: unknown) => unknown) => settle().catch(onErr);
    api.finally = (onEnd: () => void) => settle().finally(onEnd);
    return api;
  };

  const start = (kind: Op["kind"], table?: unknown) => {
    const op: Op = { kind, table, orderBy: [] };
    ops.push(op);
    return chain(op);
  };

  const db: Record<string, unknown> = {
    select: () => start("select"),
    insert: (table: unknown) => start("insert", table),
    update: (table: unknown) => start("update", table),
    delete: (table: unknown) => start("delete", table),
    transaction: (callback: (tx: Db) => Promise<unknown>) =>
      callback(db as unknown as Db),
  };
  return db as unknown as Db;
}

export function makeCache() {
  return {
    cachedForOrg: jest
      .fn()
      .mockImplementation((_org: unknown, _key: unknown, fill: () => unknown) => fill()),
    invalidateForOrg: jest.fn().mockResolvedValue(undefined),
    invalidateNamespace: jest.fn().mockResolvedValue(undefined),
  };
}

export interface Walked {
  values: unknown[];
  columns: string[];
}

export function walk(
  node: unknown,
  seen = new Set<object>(),
  acc: Walked = { values: [], columns: [] },
): Walked {
  if (node === null || node === undefined) return acc;
  if (
    typeof node === "string" ||
    typeof node === "number" ||
    typeof node === "boolean"
  ) {
    acc.values.push(node);
    return acc;
  }
  if (node instanceof Date) return acc;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, seen, acc);
    return acc;
  }
  if (typeof node !== "object" || seen.has(node)) return acc;
  seen.add(node);
  const shape = node as {
    name?: unknown;
    columnType?: unknown;
    queryChunks?: unknown;
    value?: unknown;
  };
  if (typeof shape.name === "string" && typeof shape.columnType === "string") {
    acc.columns.push(shape.name);
    return acc;
  }
  if (shape.queryChunks !== undefined) walk(shape.queryChunks, seen, acc);
  if (Object.prototype.hasOwnProperty.call(shape, "value")) {
    walk(shape.value, seen, acc);
  }
  return acc;
}
