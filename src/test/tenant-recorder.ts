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
 * Four files, every export re-exported here so a spec imports only this one:
 * `tenant-recorder.types.ts` (the shapes), `tenant-recorder-sql.ts` (reading a
 * predicate), `tenant-recorder-chain.ts` (recording the calls) and this file
 * (answering them from the fixtures).
 *
 * No `jest` import on purpose, in any of the four: they sit in `src/test/`
 * beside the other shared fixtures and must compile in the build as well as
 * under jest.
 */
import { getTableColumns, type Column, type Table } from "drizzle-orm";
import { recordingDb } from "./tenant-recorder-chain";
import { equalities, orgBindings } from "./tenant-recorder-sql";
import type {
  Row,
  Statement,
  TenantDb,
  TenantDbOptions,
  TenantFixture,
} from "./tenant-recorder.types";

export type {
  Op,
  Row,
  Statement,
  TenantDb,
  TenantDbOptions,
  TenantFixture,
} from "./tenant-recorder.types";
export { equalities, orgBindings, sqlValues } from "./tenant-recorder-sql";

// ─── Answering from the fixtures ────────────────────────────────────────────

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

  const db = recordingDb(statements, answer);

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
