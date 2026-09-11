import {
  assertNoDbCallRegression,
  assertWithinDbCallBudget,
  countDbCalls,
  dbCallCeiling,
  loadRouteBudgets,
  parseRouteBudgets,
} from "../route-budget-db-calls";
import { instrumentPostgresClient, queryTelemetry } from "../../db/query-telemetry";

/**
 * The database-call ratchet, proved in three parts:
 *   1. the counter counts — an added statement is visible;
 *   2. the assertion bites — a count over the manifest ceiling throws;
 *   3. the manifest is a usable contract — every declared budget carries a real ceiling.
 *
 * Part 1 runs against a fake client rather than Postgres so the mechanism is proved with no
 * database at all; `test/perf/route-db-call-budget.e2e-spec.ts` runs the same helpers against a
 * real service over a seeded database.
 */

interface FakeClient {
  unsafe: (query: string, params?: unknown[]) => Promise<unknown>;
}

function makeFakeClient(): FakeClient {
  const client: FakeClient = {
    unsafe: (_query: string) => Promise.resolve([]),
  };
  instrumentPostgresClient(client as unknown as { unsafe: (...args: never[]) => unknown });
  return client;
}

describe("route budget database-call ratchet", () => {
  beforeEach(() => queryTelemetry.reset());

  it("counts every statement the instrumented client issues", async () => {
    const client = makeFakeClient();
    const { count } = await countDbCalls(async () => {
      await client.unsafe("SELECT 1");
      await client.unsafe("SELECT 2");
      await client.unsafe("SELECT 3");
    });
    expect(count.queries).toBe(3);
  });

  it("sees an added statement — the regression this ratchet exists to catch", async () => {
    const client = makeFakeClient();
    const before = await countDbCalls(async () => {
      await client.unsafe("SELECT 1");
      await client.unsafe("SELECT 2");
    });
    const after = await countDbCalls(async () => {
      await client.unsafe("SELECT 1");
      await client.unsafe("SELECT 2");
      await client.unsafe("SELECT 3");
    });
    expect(after.count.queries).toBe(before.count.queries + 1);
  });

  it("does not charge tenant-GUC setup to the route's query count", async () => {
    const client = makeFakeClient();
    const { count } = await countDbCalls(async () => {
      await client.unsafe("SELECT set_config('app.organization_id', $1, true)", ["org"]);
      await client.unsafe("SELECT 1");
    });
    expect(count.queries).toBe(1);
    expect(count.gucSetups).toBe(1);
  });

  it("throws when the counted statements exceed the declared ceiling", () => {
    const manifest = parseRouteBudgets(JSON.stringify({ budgets: { "GET /x": { maxDbCalls: 3 } } }));
    expect(() => assertWithinDbCallBudget(manifest, "GET /x", 4)).toThrow(/over its declared maxDbCalls=3/);
  });

  it("passes when the counted statements are at or under the ceiling", () => {
    const manifest = parseRouteBudgets(JSON.stringify({ budgets: { "GET /x": { maxDbCalls: 3 } } }));
    expect(() => assertWithinDbCallBudget(manifest, "GET /x", 3)).not.toThrow();
  });

  it("ratchets at the last recorded measurement, not at the ceiling", () => {
    const manifest = parseRouteBudgets(
      JSON.stringify({ budgets: { "GET /x": { maxDbCalls: 5, measuredDbCalls: 4 } } }),
    );
    expect(() => assertNoDbCallRegression(manifest, "GET /x", 4)).not.toThrow();
    expect(() => assertNoDbCallRegression(manifest, "GET /x", 5)).toThrow(/above the ratchet of 4/);
  });

  it("ratchets a route that is already over budget at its measured value, and leaves the breach reported", () => {
    const manifest = parseRouteBudgets(
      JSON.stringify({ budgets: { "GET /x": { maxDbCalls: 3, measuredDbCalls: 5 } } }),
    );
    expect(() => assertNoDbCallRegression(manifest, "GET /x", 5)).not.toThrow();
    expect(() => assertNoDbCallRegression(manifest, "GET /x", 6)).toThrow(/above the ratchet of 5/);
    // The ratchet tolerating 5 must never make the budget assertion tolerate it too.
    expect(() => assertWithinDbCallBudget(manifest, "GET /x", 5)).toThrow(/over its declared maxDbCalls=3/);
  });

  it("falls back to the ceiling when nothing has been measured yet", () => {
    const manifest = parseRouteBudgets(JSON.stringify({ budgets: { "GET /x": { maxDbCalls: 3 } } }));
    expect(() => assertNoDbCallRegression(manifest, "GET /x", 3)).not.toThrow();
    expect(() => assertNoDbCallRegression(manifest, "GET /x", 4)).toThrow(/above the ratchet of 3/);
  });

  it("refuses to measure a route the manifest does not declare", () => {
    const manifest = parseRouteBudgets(JSON.stringify({ budgets: { "GET /x": { maxDbCalls: 3 } } }));
    expect(() => dbCallCeiling(manifest, "GET /unknown")).toThrow(/declares no budget/);
  });

  it("rejects a manifest entry with no usable ceiling rather than defaulting to zero", () => {
    expect(() => parseRouteBudgets(JSON.stringify({ budgets: { "GET /x": { maxDbCalls: null } } }))).toThrow(
      /no non-negative integer maxDbCalls/,
    );
  });

  it("the shipped manifest declares a usable maxDbCalls for every budget", () => {
    const manifest = loadRouteBudgets();
    const keys = Object.keys(manifest.budgets);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(dbCallCeiling(manifest, key)).toBeGreaterThan(0);
  });

  it("records how many ceilings rest on a counted call path rather than the default", () => {
    const manifest = loadRouteBudgets();
    const entries = Object.values(manifest.budgets);
    const counted = entries.filter((e) => e.dbCallBasis === "counted-call-path").length;
    const undeclared = entries.filter((e) => e.dbCallBasis === undefined).length;
    // Every entry states where its number came from. A budget with no stated basis is a number
    // nobody can audit, which is the state this ticket exists to end.
    expect(undeclared).toBe(0);
    expect(counted).toBeGreaterThan(0);
  });
});
