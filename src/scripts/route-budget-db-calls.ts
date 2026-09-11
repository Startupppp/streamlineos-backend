import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { queryTelemetry } from "../db/query-telemetry";

export const ROUTE_BUDGETS_PATH = join(
  resolve(__dirname, "../.."),
  "contracts",
  "route-budgets.json",
);

export interface RouteBudgetEntry {
  readonly maxDbCalls: number;
  readonly kind?: string;
  readonly dbCallBasis?: string;
  readonly measuredDbCalls?: number | null;
}

export interface RouteBudgetManifest {
  readonly budgets: Record<string, RouteBudgetEntry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseRouteBudgets(raw: string): RouteBudgetManifest {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !isRecord(parsed.budgets))
    throw new Error("route-budgets.json: expected an object with a `budgets` object");
  const budgets: Record<string, RouteBudgetEntry> = {};
  for (const [key, value] of Object.entries(parsed.budgets)) {
    if (!isRecord(value)) throw new Error(`route-budgets.json: budget "${key}" is not an object`);
    const maxDbCalls = value.maxDbCalls;
    if (typeof maxDbCalls !== "number" || !Number.isInteger(maxDbCalls) || maxDbCalls < 0)
      throw new Error(`route-budgets.json: budget "${key}" has no non-negative integer maxDbCalls`);
    budgets[key] = {
      maxDbCalls,
      kind: typeof value.kind === "string" ? value.kind : undefined,
      dbCallBasis: typeof value.dbCallBasis === "string" ? value.dbCallBasis : undefined,
      measuredDbCalls: typeof value.measuredDbCalls === "number" ? value.measuredDbCalls : null,
    };
  }
  return { budgets };
}

export function loadRouteBudgets(path: string = ROUTE_BUDGETS_PATH): RouteBudgetManifest {
  return parseRouteBudgets(readFileSync(path, "utf8"));
}

export function dbCallCeiling(manifest: RouteBudgetManifest, routeKey: string): number {
  const entry = manifest.budgets[routeKey];
  if (entry === undefined)
    throw new Error(
      `route-budgets.json declares no budget for "${routeKey}". A route measured against a ceiling ` +
        `that does not exist is not a regression test — add the budget first.`,
    );
  return entry.maxDbCalls;
}

export interface DbCallCount {
  readonly queries: number;
  readonly gucSetups: number;
}

/**
 * Count the database statements a piece of work issues.
 *
 * `instrumentPostgresClient` wraps `client.unsafe`, which is the single entry point Drizzle's
 * postgres-js driver uses for every statement, so this counts real round trips rather than call
 * sites. `SELECT set_config(...)` is classified separately, so arming tenant isolation never
 * inflates a route's query count.
 *
 * The tracker is a module-level singleton: run counted work serially, never inside a concurrent
 * `Promise.all` with other counted work.
 */
export async function countDbCalls<T>(work: () => Promise<T>): Promise<{ result: T; count: DbCallCount }> {
  queryTelemetry.reset();
  const result = await work();
  const snapshot = queryTelemetry.snapshot();
  return {
    result,
    count: {
      queries: snapshot["db.query.execute"].count,
      gucSetups: snapshot["db.guc.setup"].count,
    },
  };
}

export function assertWithinDbCallBudget(
  manifest: RouteBudgetManifest,
  routeKey: string,
  counted: number,
): void {
  const ceiling = dbCallCeiling(manifest, routeKey);
  if (counted > ceiling)
    throw new Error(
      `${routeKey} issued ${String(counted)} database statements, over its declared ` +
        `maxDbCalls=${String(ceiling)} in contracts/route-budgets.json. ` +
        `An implementation that adds a query must either remove one elsewhere or raise the ` +
        `budget deliberately, with the reason recorded — never silently.`,
    );
}

/**
 * The regression ratchet, as distinct from the budget.
 *
 * `assertWithinDbCallBudget` answers the gate's question — "is this route inside the budget it
 * declares" — and when the answer is no, check-route-budgets.mjs fails on the recorded
 * measurement. This answers a different one: "did this change ADD a statement".
 *
 * The line is the last recorded measurement when there is one, and the declared ceiling otherwise.
 * A route measured at 4 against a ceiling of 5 therefore ratchets at 4, so creeping up to the
 * ceiling is caught rather than tolerated. A route measured OVER its ceiling ratchets at the
 * measured value, so it cannot get worse while its owner fixes it — the breach itself stays
 * reported by the gate rather than being duplicated as a permanently red test in a shared suite.
 *
 * This never raises `maxDbCalls`. Recording a measurement is not accepting it, and moving a
 * baseline to turn a breach green is itself a defect. Recording a value above the ceiling makes
 * check-route-budgets.mjs fail, which is the coupling that keeps this honest.
 */
export function assertNoDbCallRegression(
  manifest: RouteBudgetManifest,
  routeKey: string,
  counted: number,
): void {
  const ceiling = dbCallCeiling(manifest, routeKey);
  const recorded = manifest.budgets[routeKey]?.measuredDbCalls;
  const line = typeof recorded === "number" ? recorded : ceiling;
  if (counted > line)
    throw new Error(
      `${routeKey} issued ${String(counted)} database statements, above the ratchet of ` +
        `${String(line)} (declared maxDbCalls=${String(ceiling)}, last recorded ` +
        `measuredDbCalls=${typeof recorded === "number" ? String(recorded) : "none"}). ` +
        `A change that adds a statement must remove one elsewhere, or move the budget on purpose ` +
        `with the reason recorded in contracts/route-budgets.json.`,
    );
}
