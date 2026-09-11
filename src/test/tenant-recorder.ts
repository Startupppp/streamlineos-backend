/**
 * An org-aware Drizzle double for cross-tenant isolation specs.
 *
 * Why not `modules/inventory/__tests__/isolation-harness.ts`: that double answers
 * the same rows to every read and records every `where` into one flat list, so a
 * spec can only assert that the org id appears SOMEWHERE among the predicates a
 * method built. A method that scopes its settings read and forgets to scope its
 * data read still passes that assertion, because the settings read put the org
 * id in the list.
 *
 * This one keeps each statement separate, knows which table it read, and answers
 * from per-table fixtures filtered only by the equalities the statement actually
 * BOUND. A statement that binds no org predicate gets every fixture row,
 * including the other tenant's — which is what Postgres does without RLS. So a
 * deny case ("the attacker gets nothing") goes red when the predicate is
 * removed, instead of passing because the double was told to return nothing.
 *
 * No `jest` import on purpose: this file sits in `src/test/` beside the other
 * shared fixtures and must compile in the build as well as under jest.
 */
import { Column, Param, SQL, StringChunk, Table, getTableColumns, is } from "drizzle-orm";

export type Row = Record<string, unknown>;

export type Op = "select" | "insert" | "update" | "delete" | "execute" | "query";

export interface Statement {
  readonly op: Op;
  /** `from(t)`, `insert(t)`, `update(t)`, `delete(t)`; the relational key for `query`. */
  table: unknown;
  /** The arguments of the call that opened the statement. */
  readonly args: readonly unknown[];
  readonly calls: Array<{ method: string; args: unknown[] }>;
  readonly where: unknown[];
  /** The ON condition of every join, in order. */
  readonly joins: unknown[];
  readonly values: unknown[];
  readonly set: unknown[];
}

export interface TenantFixture {
  readonly table: Table;
  /** The tenant column, spelled however this table spells it (`org_id` / `organization_id`). */
  readonly org: Column;
  /**
   * Rows as the service's projection will read them, each carrying its tenant
   * under the org column's property name (`orgId` or `organizationId`).
   */
  readonly rows: Row[];
}

export interface TenantDbOptions {
  readonly fixtures?: readonly TenantFixture[];
  /** Answers a statement before the fixtures are consulted. Return `undefined` to fall through. */
  readonly script?: (statement: Statement) => unknown;
}

// ─── Reading a predicate ────────────────────────────────────────────────────

type Token =
  | { kind: "text"; text: string }
  | { kind: "column"; column: Column }
  | { kind: "value"; value: unknown }
  | { kind: "other" };

function collect(node: unknown, out: Token[], seen: Set<object>): void {
  if (node === null || node === undefined) return;
  if (typeof node === "function") {
    out.push({ kind: "other" });
    return;
  }
  if (typeof node !== "object") {
    out.push({ kind: "value", value: node });
    return;
  }
  if (is(node, Column)) {
    out.push({ kind: "column", column: node });
    return;
  }
  if (is(node, Param)) {
    out.push({ kind: "value", value: node.value });
    return;
  }
  if (is(node, StringChunk)) {
    out.push({ kind: "text", text: node.value.join("") });
    return;
  }
  if (is(node, Table)) {
    out.push({ kind: "other" });
    return;
  }
  if (seen.has(node)) return;
  seen.add(node);
  if (is(node, SQL)) {
    for (const chunk of node.queryChunks) collect(chunk, out, seen);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collect(item, out, seen);
    return;
  }
  const record = node as { sql?: unknown; getSQL?: () => unknown; where?: unknown };
  if (record.sql !== undefined) {
    collect(record.sql, out, seen);
    return;
  }
  if (typeof record.getSQL === "function") {
    collect(record.getSQL(), out, seen);
    return;
  }
  // The relational reader hands over an options object, not the predicate.
  if (record.where !== undefined) collect(record.where, out, seen);
}

/** Adjacent string chunks merged, so `eq` inside `and(...)` reads as column, " = ", value. */
function tokensOf(expression: unknown): Token[] {
  const raw: Token[] = [];
  collect(expression, raw, new Set());
  const merged: Token[] = [];
  for (const token of raw) {
    const last = merged[merged.length - 1];
    if (token.kind === "text" && last?.kind === "text") last.text += token.text;
    else merged.push(token.kind === "text" ? { kind: "text", text: token.text } : token);
  }
  return merged;
}

/**
 * Every `column = value` equality bound in an expression.
 *
 * Covers both spellings the codebase uses: `eq(col, v)`, which binds a `Param`,
 * and a raw `sql\`${col} = ${v}\``, which leaves the value as a bare chunk.
 * A column compared with another column (a join key) binds no value and is not
 * returned — that is not a tenant predicate, it is a correlation.
 */
export function equalities(expression: unknown): Array<{ column: Column; value: unknown }> {
  const tokens = tokensOf(expression);
  const found: Array<{ column: Column; value: unknown }> = [];
  for (let i = 0; i + 2 < tokens.length; i++) {
    const [left, op, right] = [tokens[i]!, tokens[i + 1]!, tokens[i + 2]!];
    if (left.kind === "column" && op.kind === "text" && op.text.trim() === "=" && right.kind === "value")
      found.push({ column: left.column, value: right.value });
  }
  return found;
}

/** The values an expression binds to one column by equality — the tenant predicate, for the org column. */
export function orgBindings(expression: unknown, orgColumn: Column): unknown[] {
  return equalities(expression)
    .filter((binding) => binding.column === orgColumn)
    .map((binding) => binding.value);
}

/** Every scalar bound anywhere in an expression, the house `sqlValues` walk. */
export function sqlValues(expression: unknown): unknown[] {
  return tokensOf(expression)
    .filter((token): token is { kind: "value"; value: unknown } => token.kind === "value")
    .map((token) => token.value);
}

// ─── The double ─────────────────────────────────────────────────────────────

const keyCache = new WeakMap<Column, string | null>();

function propertyOf(column: Column): string | null {
  if (keyCache.has(column)) return keyCache.get(column) ?? null;
  const table = (column as unknown as { table?: Table }).table;
  let key: string | null = null;
  if (table) {
    for (const [name, candidate] of Object.entries(getTableColumns(table)))
      if (candidate === column) key = name;
  }
  keyCache.set(column, key);
  return key;
}

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

export interface TenantDb {
  /** Cast to whatever `Db` type the service's constructor names. */
  readonly db: never;
  readonly statements: Statement[];
  /** Statements against one table, optionally of one kind, in the order they were issued. */
  on(table: unknown, op?: Op): Statement[];
  /** The values a statement's WHERE binds to `orgColumn` by equality. */
  orgBound(statement: Statement | undefined, orgColumn: Column): unknown[];
  /** Every row handed to `insert(table).values(...)`, flattened. */
  inserted(table: unknown): Row[];
}

export function tenantDb(options: TenantDbOptions = {}): TenantDb {
  const statements: Statement[] = [];
  const fixtures = new Map<unknown, TenantFixture>();
  for (const fixture of options.fixtures ?? []) fixtures.set(fixture.table, fixture);

  /**
   * The rows a statement can see: filtered by every equality it binds on the
   * fixture's own columns. Nothing else narrows — a predicate that was not
   * written does not filter, so an unscoped read sees every tenant.
   */
  function visible(fixture: TenantFixture, statement: Statement): Row[] {
    const bindings = statement.where
      .flatMap((expression) => equalities(expression))
      .filter((binding) => (binding.column as unknown as { table?: unknown }).table === fixture.table);
    return fixture.rows.filter((row) =>
      bindings.every((binding) => {
        const key = propertyOf(binding.column);
        if (key === null || !(key in row)) return true;
        return row[key] === binding.value;
      }),
    );
  }

  function answer(statement: Statement): unknown {
    const scripted = options.script?.(statement);
    if (scripted !== undefined) return scripted;

    const fixture = fixtures.get(statement.table);
    switch (statement.op) {
      case "select":
        return fixture ? visible(fixture, statement).map((row) => ({ ...row })) : [];
      case "update": {
        if (!fixture) return [];
        const patch = Object.assign({}, ...statement.set.map((s) => s as Row)) as Row;
        return visible(fixture, statement).map((row) => ({ ...row, ...patch }));
      }
      case "delete":
        return fixture ? visible(fixture, statement).map((row) => ({ ...row })) : [];
      case "insert":
        return statement.values
          .flatMap((value) => (Array.isArray(value) ? value : [value]))
          .map((value, index) => ({ id: `inserted-${statements.indexOf(statement)}-${index}`, ...(value as Row) }));
      case "query":
        return statement.calls[0]?.method === "findFirst" ? null : [];
      default:
        return [];
    }
  }

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

  return {
    db: db as never,
    statements,
    on: (table, op) => statements.filter((s) => s.table === table && (op === undefined || s.op === op)),
    orgBound: (statement, orgColumn) =>
      statement ? statement.where.flatMap((expression) => orgBindings(expression, orgColumn)) : [],
    inserted: (table) =>
      statements
        .filter((s) => s.op === "insert" && s.table === table)
        .flatMap((s) => s.values.flatMap((value) => (Array.isArray(value) ? value : [value])) as Row[]),
  };
}
