/**
 * The recording half of the tenant recorder: a Drizzle-shaped handle whose
 * every builder call lands on a `Statement`, and whose chains, when awaited,
 * ask `answer` for their rows. It knows nothing about fixtures or tenants;
 * `tenant-recorder.ts` supplies the answer and hands this handle to the service.
 */
import type { Op, Statement } from "./tenant-recorder.types";

// ─── The double ─────────────────────────────────────────────────────────────

function record(statement: Statement, method: string, args: unknown[]): void {
  statement.calls.push({ method, args });
  switch (method) {
    case "from":
      statement.table = args[0];
      break;
    case "where":
      statement.where.push(args[0]);
      break;
    case "leftJoin":
    case "innerJoin":
    case "rightJoin":
    case "fullJoin":
      statement.joins.push(args[1]);
      break;
    case "values":
      statement.values.push(args[0]);
      break;
    case "set":
      statement.set.push(args[0]);
      break;
    default:
      break;
  }
}

/** A thenable Drizzle chain: every builder call is recorded, awaiting it asks `answer`. */
function chain(statement: Statement, answer: (s: Statement) => unknown): unknown {
  const settle = () => Promise.resolve().then(() => answer(statement));
  const proxy: unknown = new Proxy(function drizzleChain() {}, {
    get(_target, property) {
      if (property === "then")
        return (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
          settle().then(onFulfilled, onRejected);
      if (property === "catch")
        return (onRejected?: (e: unknown) => unknown) => settle().catch(onRejected);
      if (property === "finally") return (onFinally?: () => void) => settle().finally(onFinally);
      if (typeof property === "symbol") return undefined;
      return (...args: unknown[]) => {
        record(statement, String(property), args);
        return proxy;
      };
    },
  });
  return proxy;
}

/**
 * The handle a service receives as its `db`. Every statement it opens, the
 * relational `db.query.<table>` reads included, is pushed onto `statements` in
 * the order it was issued, and awaiting it asks `answer`.
 */
export function recordingDb(
  statements: Statement[],
  answer: (statement: Statement) => unknown,
): Record<string, unknown> {
  const open =
    (op: Op) =>
    (...args: unknown[]): unknown => {
      const statement: Statement = {
        op,
        table: op === "select" || op === "execute" ? undefined : args[0],
        args,
        calls: [],
        where: [],
        joins: [],
        values: [],
        set: [],
      };
      statements.push(statement);
      return chain(statement, answer);
    };

  const relational = new Proxy(
    {},
    {
      get(_target, key) {
        const read = (method: "findFirst" | "findMany") => (opts?: { where?: unknown }) => {
          const statement: Statement = {
            op: "query",
            table: String(key),
            args: [opts],
            calls: [{ method, args: [opts] }],
            where: opts?.where === undefined ? [] : [opts.where],
            joins: [],
            values: [],
            set: [],
          };
          statements.push(statement);
          return chain(statement, answer);
        };
        return { findFirst: read("findFirst"), findMany: read("findMany") };
      },
    },
  );

  const db: Record<string, unknown> = {
    select: open("select"),
    selectDistinct: open("select"),
    selectDistinctOn: open("select"),
    insert: open("insert"),
    update: open("update"),
    delete: open("delete"),
    execute: open("execute"),
    query: relational,
  };
  /** The transaction handle IS the recorder, so work done inside it is still watched. */
  db.transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(db);
  return db;
}
