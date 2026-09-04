import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "../../db/schema";
import { matchesPredicate } from "../../test/sql-predicate";
import { parseTraceparent } from "../../common/observability/tracing";
import { queryTelemetry } from "../../db/query-telemetry";
import { OperatorSessionGuard } from "../../modules/platform/operator-session.guard";
import { organizations } from "../../db/schema";

/**
 * The runtime contract behind every `external` entry in the DOUBLE_CAST_LEDGER
 * of `check-type-assertions.mjs`.
 *
 * PRD-C031 permits a type assertion only at a proven external seam and requires
 * each one to be "covered by a negative/runtime contract test". Until this file
 * existed that clause had no mechanism at all: 0 of the ledger's entries named a
 * test, and nothing checked that any of the invariants written into them were
 * still true. A documented invariant nobody executes is a comment.
 *
 * Every test here is named by a `test:` field on the entry it covers, and the
 * gate's self-test asserts that this file exists and that each named title is
 * in it — so deleting or renaming a test fails the gate rather than quietly
 * un-covering a cast.
 *
 * Each one is written to FAIL if the seam changes underneath the cast, which is
 * the only failure mode a cast has: the compiler has already been told to stop
 * looking.
 */

const SRC = join(__dirname, "..", "..");

function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      yield* walkTs(full);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) yield full;
  }
}

describe("assertion ledger — external seam contracts", () => {
  /**
   * Covers: benchmark-access-service.ts, check-declaration-column-drift.ts,
   * check-set-null-column-lists.ts, verify-cell-admission.ts,
   * verify-cell-degraded-control-plane.ts, seed-permissions.ts.
   *
   * Every one of those entries rests on the same load-bearing sentence — "it
   * never runs in the application". A stub `Db` built from a Proxy that throws
   * on every property, or a nominally-different Drizzle client, is survivable
   * in a one-shot script and is a production outage inside a request. Nothing
   * enforced that sentence, so the day someone imports a helper out of one of
   * these files the invariant becomes false in silence.
   */
  it("keeps every ledgered standalone script out of the application import graph", () => {
    const ledgeredScripts = [
      "benchmark-access-service",
      "check-declaration-column-drift",
      "check-set-null-column-lists",
      "verify-cell-admission",
      "verify-cell-degraded-control-plane",
      "seed-permissions",
    ];
    const offenders: string[] = [];
    let scanned = 0;

    for (const file of walkTs(SRC)) {
      const rel = relative(SRC, file).replace(/\\/g, "/");
      if (rel.startsWith("scripts/")) continue;
      if (/\.(spec|e2e-spec|db\.spec|test)\.ts$/.test(rel)) continue;
      scanned += 1;
      const source = readFileSync(file, "utf8");
      for (const name of ledgeredScripts)
        if (new RegExp(`from\\s+["'][^"']*scripts/${name}["']`).test(source))
          offenders.push(`${rel} -> ${name}`);
    }

    expect(scanned).toBeGreaterThan(1000);
    expect(offenders).toEqual([]);
  });

  /**
   * Covers: verify-cell-admission.ts, verify-cell-degraded-control-plane.ts,
   * seed-permissions.ts — "`drizzle(client, { schema })` instantiates to a
   * structurally identical but nominally different type than the app's `Db`
   * alias".
   *
   * Structurally identical is the whole claim, and it is a runtime claim: the
   * scripts go on to call app services through that value. If a Drizzle upgrade
   * moved or renamed any of these, the cast would keep compiling and the script
   * would die at its first call.
   */
  it("builds a standalone client that exposes the surface the app's Db alias is used through", () => {
    const client = postgres("postgres://unused@127.0.0.1:1/unused", {
      max: 1,
      prepare: false,
      onnotice: () => {},
      connection: { application_name: "assertion-seam-contract" },
    });
    try {
      const standalone = drizzle(client, { schema });
      for (const member of ["select", "insert", "update", "delete", "execute", "transaction"]) {
        expect(typeof (standalone as unknown as Record<string, unknown>)[member]).toBe("function");
      }
      expect(typeof standalone.query).toBe("object");
      expect(standalone.query.organizations).toBeDefined();
    } finally {
      void client.end({ timeout: 0 }).catch(() => {});
    }
  });

  /**
   * Covers: check-declaration-column-drift.ts and check-set-null-column-lists.ts
   * — "two casts hand the Drizzle schema barrel to a reflective walker as
   * `Record<string, unknown>`".
   *
   * The cast is survivable only while the barrel really is a flat record of
   * inspectable table objects. Root CLAUDE.md section 10 records the exact way
   * this goes wrong unnoticed: a reflective scan whose shape assumption breaks
   * reports that EVERY table is unreferenced and reads as a clean run. This
   * asserts the barrel is walkable and that the walk finds a real population,
   * so an empty or restructured barrel fails here instead.
   */
  it("keeps the Drizzle schema barrel walkable as a flat record of inspectable tables", () => {
    const entries = Object.entries(schema as unknown as Record<string, unknown>);
    expect(entries.length).toBeGreaterThan(200);

    const tables = entries.filter(
      ([, value]) =>
        typeof value === "object"
        && value !== null
        && Object.getOwnPropertySymbols(value).some((s) => String(s).includes("drizzle:Name")),
    );
    expect(tables.length).toBeGreaterThan(200);
    expect(Object.keys(organizations)).toContain("id");
  });

  /**
   * Covers: src/test/sql-predicate.ts — "reads Drizzle's internal SQL AST node
   * shape, which the library does not export … it breaks loudly on a Drizzle
   * upgrade rather than silently".
   *
   * "Breaks loudly" is the invariant, and it was untested. `queryChunks`,
   * `StringChunk.value` being a `string[]` and `Param.value` holding the bound
   * value are all private shape. This exercises all three through the public
   * reader with a predicate that must match and one that must not — a silent
   * break would make every predicate assertion in the suite vacuously true.
   */
  it("still reads drizzle-orm's private SQL chunk shape, and says so by matching", () => {
    const rows = { organizations: [{ id: "org-1" }] };
    expect(matchesPredicate(eq(organizations.id, "org-1"), rows)).toBe(true);
    expect(matchesPredicate(eq(organizations.id, "org-2"), rows)).toBe(false);
    expect(matchesPredicate(undefined, rows)).toBe(true);
  });

  /**
   * Covers: src/common/observability/tracing.ts — "a `RegExpMatchArray` is
   * typed as `string[]` but the W3C traceparent regex has four capture groups,
   * so a successful match has exactly five elements."
   *
   * If a group is ever dropped or reordered, the cast keeps the tuple type and
   * `flags` becomes `undefined`; `Number.parseInt(undefined, 16) & 1` is 0, so
   * every inbound sampled trace silently becomes unsampled and the tracing goes
   * dark without an error. Both flag values are asserted for that reason.
   */
  it("fills all four traceparent capture groups on a successful match", () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const spanId = "00f067aa0ba902b7";

    const sampled = parseTraceparent(`00-${traceId}-${spanId}-01`);
    expect(sampled).toEqual({ traceId, spanId, sampled: true });

    const unsampled = parseTraceparent(`00-${traceId}-${spanId}-00`);
    expect(unsampled).toEqual({ traceId, spanId, sampled: false });

    expect(parseTraceparent(`00-${"0".repeat(32)}-${spanId}-01`)).toBeNull();
    expect(parseTraceparent("nonsense")).toBeNull();
  });

  /**
   * Covers: src/db/query-telemetry.ts — "the instrumentation proxy wraps a
   * Drizzle query builder that is thenable at runtime but not declared
   * `PromiseLike`. The cast names the `.then` that is provably there — the
   * proxy only reaches this branch after checking for it."
   *
   * The value under the cast is a driver object, so the claim is about the
   * driver, not about our types. If a wrapped result ever stopped being
   * thenable the proxy would call `.then` on something that has none and every
   * instrumented query would reject with a TypeError instead of returning rows.
   */
  it("awaits a wrapped result that is thenable without declaring PromiseLike", async () => {
    const before = queryTelemetry.snapshot()["db.query.execute"].count;

    const pending = {
      then(onOk?: (v: unknown) => unknown) {
        return Promise.resolve([{ id: 1 }]).then(onOk);
      },
    };

    const observed = queryTelemetry.observe(pending, "SELECT 1");
    await expect(observed as unknown as Promise<unknown>).resolves.toEqual([{ id: 1 }]);
    expect(queryTelemetry.snapshot()["db.query.execute"].count).toBe(before + 1);

    const failing = {
      then(_onOk?: (v: unknown) => unknown, onErr?: (r: unknown) => unknown) {
        return Promise.reject(new Error("driver said no")).then(undefined, onErr);
      },
    };
    await expect(
      queryTelemetry.observe(failing, "SELECT 2") as unknown as Promise<unknown>,
    ).rejects.toThrow("driver said no");
  });

  /**
   * Covers: src/modules/platform/operator-session.guard.ts — "`req.route` is
   * attached by Express at dispatch time and is absent from the Nest request
   * type. Read optionally with a `?? req.url` fallback, so an absent route
   * degrades to the raw URL rather than throwing."
   *
   * The negative half is the point. A guard that threw here would 500 every
   * operator route the moment Express stopped attaching `route` — and this is
   * the audit path, so the failure would be on the surface that records who did
   * what.
   */
  it("degrades an absent Express route object to the raw url instead of throwing", async () => {
    const actions: string[] = [];
    const operatorAccess = {
      authorizeRequest: async (
        _userId: string,
        _orgId: string,
        _scope: unknown,
        action: string,
      ) => {
        actions.push(action);
      },
    };
    const reflector = { getAllAndOverride: () => "read" };
    const guard = new OperatorSessionGuard(
      reflector as never,
      operatorAccess as never,
    );

    const makeContext = (req: Record<string, unknown>) =>
      ({
        getHandler: () => undefined,
        getClass: () => undefined,
        switchToHttp: () => ({ getRequest: () => req }),
      }) as never;

    const base = {
      user: { userId: "u-1", principal: { kind: "human-session" } },
      params: { orgId: "org-1" },
      method: "GET",
      headers: {},
      url: "/platform/orgs/org-1/cells",
    };

    await expect(guard.canActivate(makeContext({ ...base }))).resolves.toBe(true);
    expect(actions).toEqual(["operator.get./platform/orgs/org-1/cells"]);

    actions.length = 0;
    await expect(
      guard.canActivate(makeContext({ ...base, route: { path: "/platform/orgs/:orgId/cells" } })),
    ).resolves.toBe(true);
    expect(actions).toEqual(["operator.get./platform/orgs/:orgId/cells"]);
  });
});
