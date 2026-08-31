import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";

/**
 * F6 — the machinery the eval suite drives the real services with.
 *
 * Two rules this file exists to keep.
 *
 * **No provider, ever.** The gateway is stubbed and the stub is scripted, so a
 * case describes what the model said and the suite asserts what the *server*
 * then did. A suite that called a real model would measure the model's mood and
 * would be unrunnable in CI, which is the same as not existing.
 *
 * **The gate is real even though the database is not.** The tenant cases build
 * the actual `WarehouseScopeService` over a fixture of real assignment rows and
 * a real permission set, and then read the SQL the services emit. Stubbing the
 * scope service to answer "denied" would prove nothing except that the stub
 * works; rendering the predicate proves the id is bound into the query.
 */

/** A dialect instance, so a predicate can be read as SQL text and parameters. */
const dialect = new PgDialect();

export function renderSql(statement: SQL): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(statement);
  return { sql: query.sql, params: query.params };
}

export const EVAL_ORG = "org-eval";
export const EVAL_USER = "user-eval";

export const EVAL_ACTOR: CurrentUserContext = {
  userId: EVAL_USER,
  orgId: EVAL_ORG,
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "session-eval",
  tokenScopes: null,
  principal: {
    kind: "human-session",
    membershipId: 1,
    isOrgOwner: false,
  },
};

/**
 * A drizzle stand-in that records every `where` it is handed and answers each
 * awaited chain with the next canned page.
 *
 * The chain object is itself thenable, so a chain ending in `.offset()` and one
 * ending in `.where()` both resolve — which is what `Promise.all([rows, count])`
 * in a paged list needs.
 */
export function recordingDb(pages: readonly unknown[][]) {
  const wheres: SQL[] = [];
  let call = 0;
  const chain: Record<string, unknown> = {};
  for (const method of [
    "select",
    "from",
    "innerJoin",
    "leftJoin",
    "groupBy",
    "orderBy",
    "having",
    "limit",
    "offset",
    "set",
    "values",
    "returning",
    "update",
    "insert",
    "onConflictDoUpdate",
  ]) {
    chain[method] = () => chain;
  }
  chain["where"] = (statement: SQL) => {
    wheres.push(statement);
    return chain;
  };
  chain["then"] = (
    resolve: (value: unknown) => unknown,
    reject: (reason: unknown) => unknown,
  ) => Promise.resolve(pages[call++] ?? []).then(resolve, reject);

  return {
    db: chain as never,
    wheres,
    /** Every predicate the run emitted, rendered. */
    rendered: () => wheres.map(renderSql),
    calls: () => call,
  };
}

/**
 * A real `AccessService`-shaped stand-in.
 *
 * `resolveUserPermissions` is what `WarehouseScopeService` consults, so this is
 * where "does this person hold the org-wide warehouse scope" is decided — the
 * one input that turns the tenant fixtures from restricted into unrestricted.
 */
export function accessStub(permissions: readonly string[]) {
  const held = new Set(permissions);
  return {
    resolveUserPermissions: () => Promise.resolve(held),
    holds: (_user: CurrentUserContext, key: string) => Promise.resolve(held.has(key)),
  };
}

/** A database that answers exactly one question: which warehouses is this person assigned to. */
export function warehouseAssignmentDb(warehouseIds: readonly number[]) {
  const rows = warehouseIds.map((warehouseId) => ({ warehouseId }));
  const chain: Record<string, unknown> = {};
  chain["select"] = () => chain;
  chain["from"] = () => chain;
  chain["where"] = () => Promise.resolve(rows);
  return chain as never;
}

/** Every non-test TypeScript file under a directory, recursively. */
export function sourceFilesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!path.endsWith(".ts")) continue;
      if (path.includes("__tests__") || path.endsWith(".spec.ts")) continue;
      found.push(path);
    }
  };
  walk(root);
  return found.sort();
}

export function readSource(path: string): string {
  return readFileSync(path, "utf8");
}
