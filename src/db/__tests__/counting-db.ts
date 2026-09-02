/**
 * A database double that counts statements.
 *
 * "It still returns the right rows" does not prove an N+1 was removed — the
 * broken shape returns the right rows too, just N times. The only proof is the
 * number of round trips, measured while the row count changes: a fixed shape
 * holds its count, a per-row shape tracks the input.
 *
 * Every chain root (`select`, `insert`, `update`, `delete`, `execute`) is one
 * statement and is recorded once, when the chain starts. Builder methods after
 * it (`from`, `where`, `values`, `onConflictDoUpdate`, `returning`, …) are not
 * separate calls and are not counted; the chain is a thenable that resolves to
 * the next queued result for that root.
 */

export type CountingOp =
  | "select"
  | "insert"
  | "update"
  | "delete"
  | "execute"
  | "transaction"
  | "query";

export interface CountingDb {
  db: unknown;
  calls: CountingOp[];
  countOf: (op: CountingOp) => number;
  statements: () => number;
}

export interface CountingPlan {
  select?: unknown[];
  insert?: unknown[];
  update?: unknown[];
  delete?: unknown[];
  execute?: unknown[];
  /** Relational `db.query.<table>.<method>` results, keyed `"table.method"`. */
  query?: Record<string, unknown[]>;
  /** Returned when a root's queue is exhausted. Defaults to an empty array. */
  fallback?: unknown;
}

type Chain = Record<string, (...args: unknown[]) => unknown> & PromiseLike<unknown>;

function chain(result: unknown): Chain {
  const handler: ProxyHandler<Record<string, never>> = {
    get(_target, property) {
      if (property === "then")
        return (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve(result).then(onFulfilled, onRejected);
      if (property === "catch")
        return (onRejected?: (reason: unknown) => unknown) => Promise.resolve(result).catch(onRejected);
      if (property === "finally")
        return (onFinally?: () => void) => Promise.resolve(result).finally(onFinally);
      if (typeof property === "symbol") return undefined;
      return () => chain(result);
    },
  };
  return new Proxy({}, handler) as unknown as Chain;
}

function nextResult(queue: unknown[] | undefined, fallback: unknown): unknown {
  if (queue && queue.length > 0) return queue.shift();
  return fallback;
}

export function makeCountingDb(plan: CountingPlan = {}): CountingDb {
  const calls: CountingOp[] = [];
  const fallback = plan.fallback ?? [];

  const queues: Record<string, unknown[] | undefined> = {
    select: plan.select ? [...plan.select] : undefined,
    insert: plan.insert ? [...plan.insert] : undefined,
    update: plan.update ? [...plan.update] : undefined,
    delete: plan.delete ? [...plan.delete] : undefined,
    execute: plan.execute ? [...plan.execute] : undefined,
  };

  const root = (op: CountingOp) => (): Chain => {
    calls.push(op);
    return chain(nextResult(queues[op], fallback));
  };

  const queryQueues: Record<string, unknown[]> = {};
  for (const [key, values] of Object.entries(plan.query ?? {})) queryQueues[key] = [...values];

  const queryProxy = new Proxy(
    {},
    {
      get(_target, table) {
        if (typeof table === "symbol") return undefined;
        return new Proxy(
          {},
          {
            get(_inner, method) {
              if (typeof method === "symbol") return undefined;
              return async (): Promise<unknown> => {
                calls.push("query");
                const key = `${table}.${method}`;
                const queue = queryQueues[key];
                if (queue && queue.length > 0) return queue.shift();
                return method === "findMany" ? [] : undefined;
              };
            },
          },
        );
      },
    },
  );

  const db: Record<string, unknown> = {
    select: root("select"),
    insert: root("insert"),
    update: root("update"),
    delete: root("delete"),
    execute: root("execute"),
    query: queryProxy,
  };

  db["transaction"] = async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
    calls.push("transaction");
    return fn(db);
  };

  return {
    db,
    calls,
    countOf: (op) => calls.filter((call) => call === op).length,
    statements: () =>
      calls.filter((call) => call !== "transaction").length,
  };
}
