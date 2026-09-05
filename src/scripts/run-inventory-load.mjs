/**
 * T16 — inventory's load gate. PRD §12.9 asked for one and there was none.
 *
 * `pnpm load:drive` drives five workloads and not one of them touches
 * inventory: grepping `inventor|stock|warehouse` across `src/scripts/load-driver/`
 * returns zero hits. The workloads there are cross-org exposure, permission
 * revocation, durable event loss, availability and node failure — platform
 * properties, driven against `organization_members`.
 *
 * The nearest inventory-shaped thing was `pnpm db:check-read-budgets`, which
 * holds nine `inv-*` budgets. Those are **single-query `EXPLAIN`** against an
 * otherwise idle database: they answer "is the plan right", which is a
 * different question from "does the plan hold when sixteen pickers are asking
 * at once". This drives exactly those nine shapes concurrently.
 *
 * Reuse rather than a second harness, deliberately:
 *
 *   - the read shapes are imported from `read-cost-budgets.mjs`, so the load
 *     gate and the cost gate can never measure different SQL;
 *   - the windows come from `load-driver/load-profile.mjs` — the same
 *     concurrency, warmup, burst multiplier and duration `load:drive` uses;
 *   - the statistics come from `load-driver/percentiles.mjs`, including
 *     `judge`, so MET / BREACHED / NOT_DRIVEN mean here what they mean there;
 *   - the target comes from the PRD's own `LATENCY_OBJECTIVES`
 *     (`p95-complex-db-read`). No number in this file was invented for it.
 *
 * ## What a green here does and does not mean
 *
 * It means: nine tenant-scoped inventory reads were issued concurrently as the
 * application role with row-level security enforced, none errored, requests
 * genuinely overlapped, and the p95 stayed inside the declared objective.
 *
 * It does not mean the module is fast for a customer. There is no HTTP layer,
 * no authorization, no serialization and no network between regions. It is the
 * database floor of the read path under concurrency, which is the part that
 * degrades first and the part nothing measured at all.
 *
 * ## Fail-closed
 *
 * Four ways this refuses rather than reporting a comfortable number:
 *
 *   - the measuring role must not hold `BYPASSRLS`. As the owner every plan
 *     omits the tenant predicate and every figure is a fiction;
 *   - a workload whose tenant holds fewer rows than the budget's own `minRows`
 *     is NOT_DRIVEN with the count, never driven against an empty table;
 *   - requests must be observed overlapping in `pg_stat_activity`. A driver
 *     that accidentally serialised would otherwise report excellent latency
 *     and have measured nothing about load;
 *   - fewer than `MIN_DRIVEN` workloads driven is a failed run, not a partial
 *     success.
 *
 *   node src/scripts/run-inventory-load.mjs
 *   node src/scripts/run-inventory-load.mjs --concurrency=32 --duration=20000
 *   node src/scripts/run-inventory-load.mjs --self-test
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { BUDGETS } from "./read-cost-budgets.mjs";
import { LATENCY_OBJECTIVES } from "./envelope-profile.mjs";
import { DEFAULT_SHAPE, RUN_CONDITIONS, describeShape } from "./load-driver/load-profile.mjs";
import { achievedRate, judge, summarise } from "./load-driver/percentiles.mjs";

const argv = process.argv.slice(2);

if (argv.includes("--help")) {
  console.log(`
Drive inventory's nine read shapes under concurrency and report the PRD's
p95-complex-db-read objective for each.

  pnpm load:drive:inventory
  pnpm load:drive:inventory --concurrency=32 --duration=20000
  pnpm load:drive:inventory --self-test

DATABASE_URL is required and is never read from .env — that file points at a
shared branch. The role named by APP_DB_ROLE (default streamline_app) is assumed
for every measured statement and must not hold BYPASSRLS.

Writes .inventory-load-results.json.
`);
  process.exit(0);
}

const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const SELF_TEST = argv.includes("--self-test");
const SHAPE = {
  concurrency: Number(flag("concurrency", String(DEFAULT_SHAPE.concurrency))),
  durationMs: Number(flag("duration", String(DEFAULT_SHAPE.durationMs))),
  warmupMs: Number(flag("warmup", String(DEFAULT_SHAPE.warmupMs))),
  burstMultiplier: Number(flag("burst", String(DEFAULT_SHAPE.burstMultiplier))),
  burstDurationMs: Number(flag("burst-duration", String(DEFAULT_SHAPE.burstDurationMs))),
};
const OUT = resolve(process.cwd(), flag("out", ".inventory-load-results.json"));
const ASSUME_ROLE = process.env.APP_DB_ROLE ?? "streamline_app";

/** The objective every one of these shapes is judged against, from the PRD. */
const OBJECTIVE_NAME = "p95-complex-db-read";

/**
 * Anti-vacuity floors. Every one of these has a failure mode it exists to
 * catch, and every one of them is reported in the summary whether it passes or
 * not, so a green cannot be read as more than it is.
 */
const MIN_DRIVEN = 5;
const MIN_SAMPLES = 200;
/** How much overlap counts as concurrent. Half the requested workers. */
const MIN_OBSERVED_CONCURRENCY = (concurrency) => Math.max(2, Math.ceil(concurrency / 2));
/** Nine `inv-*` budgets exist today; a rename that silently drops them fails. */
const MIN_WORKLOADS = 9;

const started = Date.now();
const log = (m) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`);

export function inventoryBudgets(budgets = BUDGETS) {
  return budgets.filter((b) => b.id.startsWith("inv-"));
}

/**
 * The weakest sustained window in the run, not the strongest.
 *
 * A run is only as concurrent as its least concurrent workload; taking the
 * maximum would let one busy window vouch for eight serialised ones.
 */
export function weakestConcurrency(driven) {
  if (driven.length === 0) return 0;
  return Math.min(...driven.map((w) => w.observedConcurrency ?? 0));
}

/**
 * The whole-run verdict, as a pure function of what was measured — so the
 * self-test can prove the gate is capable of failing without a database.
 */
export function verdictFor(run) {
  const failures = [];
  if (run.bypassRls) failures.push(`the measuring role ${run.role} holds BYPASSRLS`);
  for (const [name, value] of Object.entries(run.shape ?? {}))
    if (!Number.isFinite(value) || value <= 0)
      failures.push(`--${name} is ${value}; a window of that length measures nothing`);
  if (run.workloadCount < MIN_WORKLOADS)
    failures.push(`only ${run.workloadCount} inventory read shapes found, expected ${MIN_WORKLOADS}`);
  if (run.driven.length < MIN_DRIVEN)
    failures.push(`only ${run.driven.length} workloads driven, floor is ${MIN_DRIVEN}`);
  if (run.observedConcurrency < MIN_OBSERVED_CONCURRENCY(run.concurrency))
    failures.push(
      `requests did not overlap: peak ${run.observedConcurrency} active backends,` +
        ` floor ${MIN_OBSERVED_CONCURRENCY(run.concurrency)} at concurrency ${run.concurrency}`,
    );
  for (const w of run.driven) {
    if (w.errors > 0) failures.push(`${w.id}: ${w.errors} error(s) — first: ${w.firstError}`);
    if (w.samples < MIN_SAMPLES)
      failures.push(`${w.id}: ${w.samples} samples, floor is ${MIN_SAMPLES}`);
    if (w.verdict === "BREACHED")
      failures.push(`${w.id}: p95 ${w.p95?.toFixed(1)}ms over the ${run.target}ms objective`);
    // A workload in `driven` that produced no judgement is a hole, not a pass.
    // A `--duration` that parsed to NaN gave `Date.now() < NaN` = false, so the
    // sustained window ran zero iterations, every verdict came back NOT_DRIVEN,
    // and the run PASSED on burst samples alone. Found by a bite proof.
    if (w.verdict !== "MET" && w.verdict !== "BREACHED")
      failures.push(`${w.id}: driven but judged ${w.verdict} — no sustained window was measured`);
    if (w.p95 !== null && run.networkFloorP50 !== null && w.p95 < run.networkFloorP50 / 2)
      failures.push(
        `${w.id}: p95 ${w.p95.toFixed(2)}ms is below half the ${run.networkFloorP50.toFixed(2)}ms` +
          ` network floor, so the statement cannot have run`,
      );
  }
  return { ok: failures.length === 0, failures };
}

/**
 * The name every driven connection reports to `pg_stat_activity`.
 *
 * Load-bearing, not cosmetic. The concurrency observer used to count every
 * active backend in the database, so anything else connected to it — another
 * agent's jest run, a psql session — counted as this driver's own overlap. The
 * bite proof caught it: `--concurrency=1` still PASSED, reporting a peak of 17.
 */
const DRIVER_APPLICATION_NAME = "inventory-load-driver";

function connect(url, max, applicationName) {
  const ssl = /\.neon\.tech/i.test(url) ? { ssl: "require" } : {};
  return postgres(url, {
    max,
    prepare: false,
    onnotice: () => {},
    connection: { application_name: applicationName },
    ...ssl,
  });
}

async function census(sql, orgId) {
  const counts = new Map();
  for (const budget of inventoryBudgets()) {
    if (counts.has(budget.rowCountSql)) continue;
    const [row] = await sql.unsafe(budget.rowCountSql, [orgId]);
    counts.set(budget.rowCountSql, Number(Object.values(row ?? {})[0] ?? 0));
  }
  return counts;
}

async function cursorFixtures(sql, orgId) {
  const [ledger] = await sql`
    SELECT to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS cursor_at, id
    FROM inv_stock_transactions WHERE org_id = ${orgId}
    ORDER BY created_at DESC, id DESC OFFSET 50 LIMIT 1`;
  const [audit] = await sql`
    SELECT to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS cursor_at, id
    FROM inv_audit_events WHERE org_id = ${orgId}
    ORDER BY created_at DESC, id DESC OFFSET 10 LIMIT 1`;
  return {
    orgId,
    ledgerCursorAt: ledger?.cursor_at ?? null,
    ledgerCursorId: ledger?.id ?? null,
    auditCursorAt: audit?.cursor_at ?? null,
    auditCursorId: audit?.id ?? null,
  };
}

async function largestInventoryTenant(sql) {
  const rows = await sql`
    SELECT org_id, count(*)::int AS movements
    FROM inv_stock_transactions GROUP BY org_id ORDER BY movements DESC LIMIT 1`;
  return rows[0] ?? null;
}

/** One measured issue of one budget, as the application role, tenant GUC set. */
async function issue(sql, budget, params) {
  const t0 = process.hrtime.bigint();
  await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${ASSUME_ROLE}`);
    await tx`SELECT set_config('app.organization_id', ${String(budget.orgId)}, true)`;
    await tx.unsafe(budget.sql, params);
  });
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

async function driveWindow(sql, budget, params, concurrency, durationMs) {
  const samples = [];
  const errors = [];
  const deadline = Date.now() + durationMs;
  const worker = async () => {
    while (Date.now() < deadline) {
      try {
        samples.push(await issue(sql, budget, params));
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
        if (errors.length > 20) return;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { samples, errors };
}

/**
 * Peak overlapping backends, sampled from a connection outside the pool being
 * driven. Without this the driver could be issuing one statement at a time and
 * every latency figure would be a single-user measurement wearing the word
 * "load".
 *
 * The peak is **resettable, and read per window**. The first version tracked one
 * peak across the whole run, and the bite proof caught it: `--concurrency=1`
 * still PASSED (`EXIT=0`), because the burst window runs at
 * `concurrency × burstMultiplier` = 2 and that alone cleared the floor. A run
 * whose sustained window serialised would have reported excellent latency and
 * been called load. What is judged now is the *sustained* window of every driven
 * workload, and the run carries the weakest of them.
 */
function concurrencyWatcher(observer) {
  let peak = 0;
  let running = true;
  const loop = (async () => {
    while (running) {
      try {
        const [row] = await observer`
          SELECT count(*)::int AS active FROM pg_stat_activity
          WHERE datname = current_database() AND state = 'active'
            AND application_name = ${DRIVER_APPLICATION_NAME}
            AND pid <> pg_backend_pid()`;
        peak = Math.max(peak, Number(row?.active ?? 0));
      } catch {
        /* the observer losing a sample must not fail the run */
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  })();
  return {
    reset() {
      peak = 0;
    },
    peak: () => peak,
    async stop() {
      running = false;
      await loop;
    },
  };
}

async function networkFloor(sql, durationMs) {
  const samples = [];
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    const t0 = process.hrtime.bigint();
    await sql`SELECT 1 AS ok`;
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return summarise(samples);
}

function selfTest() {
  const failures = [];
  const healthyWorkload = (id) => ({
    id,
    errors: 0,
    samples: 1000,
    verdict: "MET",
    p95: 4,
    observedConcurrency: 16,
  });
  const base = {
    role: ASSUME_ROLE,
    bypassRls: false,
    workloadCount: MIN_WORKLOADS,
    concurrency: 16,
    observedConcurrency: 16,
    target: 50,
    networkFloorP50: 1,
    shape: { ...DEFAULT_SHAPE },
    driven: inventoryBudgets()
      .slice(0, MIN_DRIVEN)
      .map((b) => healthyWorkload(b.id)),
  };
  /** The same run with its first workload replaced by a broken one. */
  const withBroken = (patch) => ({
    ...base,
    driven: [{ ...base.driven[0], ...patch }, ...base.driven.slice(1)],
  });

  const healthy = verdictFor(base);
  if (!healthy.ok) failures.push(`a healthy run was reported failing: ${healthy.failures.join("; ")}`);

  const cases = [
    ["a BYPASSRLS role", { ...base, bypassRls: true }],
    ["a breached objective", withBroken({ verdict: "BREACHED", p95: 900 })],
    ["an errored workload", withBroken({ errors: 3, firstError: "boom" })],
    ["too few samples", withBroken({ samples: 4 })],
    ["serialised requests", { ...base, observedConcurrency: 1 }],
    [
      "one workload of five serialising while the rest did not",
      { ...base, observedConcurrency: weakestConcurrency(withBroken({ observedConcurrency: 1 }).driven) },
    ],
    ["too few workloads driven", { ...base, driven: [] }],
    ["the inventory shapes disappearing", { ...base, workloadCount: 0 }],
    ["a p95 under the network floor", { ...base, networkFloorP50: 40 }],
    ["a workload driven but never judged", withBroken({ verdict: "NOT_DRIVEN", p95: null })],
    ["a duration that parsed to NaN", { ...base, shape: { ...DEFAULT_SHAPE, durationMs: Number.NaN } }],
    ["a zero-length sustained window", { ...base, shape: { ...DEFAULT_SHAPE, durationMs: 0 } }],
  ];
  for (const [label, run] of cases)
    if (verdictFor(run).ok) failures.push(`${label} was reported as a pass`);

  const shapes = inventoryBudgets();
  if (shapes.length < MIN_WORKLOADS)
    failures.push(`only ${shapes.length} inventory read shapes are exported, expected ${MIN_WORKLOADS}`);
  if (!LATENCY_OBJECTIVES.some((o) => o.name === OBJECTIVE_NAME))
    failures.push(`the PRD objective ${OBJECTIVE_NAME} this gate judges against no longer exists`);
  if (judge({ percentileKey: "p95", target: 10 }, summarise([100, 200])).verdict !== "BREACHED")
    failures.push("the shared judge no longer reports a breach");
  if (weakestConcurrency([{ observedConcurrency: 16 }, { observedConcurrency: 1 }]) !== 1)
    failures.push("a serialised window is no longer the run's concurrency figure");
  if (weakestConcurrency([]) !== 0)
    failures.push("a run that drove nothing does not report zero concurrency");

  if (failures.length === 0) {
    console.log(
      `SELF-TEST PASS: ${shapes.length} inventory read shapes found, and each of the` +
        ` ${cases.length} failure modes above is reported as a failure — the gate can fail.`,
    );
    return;
  }
  for (const f of failures) console.error(`SELF-TEST FAIL: ${f}`);
  process.exitCode = 1;
}

async function main() {
  if (SELF_TEST) return selfTest();

  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error("REFUSED: DATABASE_URL is required and is never read from .env here.");
    process.exitCode = 1;
    return;
  }

  const pool = connect(url, SHAPE.concurrency * SHAPE.burstMultiplier + 4, DRIVER_APPLICATION_NAME);
  const observer = connect(url, 1, "inventory-load-observer");

  try {
    const [effective] = await pool.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${ASSUME_ROLE}`);
      return tx`SELECT current_user,
                       (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`;
    });
    const bypassRls = Boolean(effective?.bypass);
    log(`measuring as ${effective?.current_user}${bypassRls ? " — WHICH HOLDS BYPASSRLS" : " (no BYPASSRLS)"}`);

    const tenant = await largestInventoryTenant(pool);
    if (tenant === null) {
      console.error(
        "REFUSED: no organisation has any rows in inv_stock_transactions, so there is nothing" +
          " to drive. Seed one with src/scripts/seed-inventory-load.mjs.",
      );
      process.exitCode = 1;
      return;
    }
    const orgId = String(tenant.org_id);
    log(`driving organisation ${orgId} — ${tenant.movements} ledger rows`);

    const fixtures = await cursorFixtures(pool, orgId);
    const rowCounts = await census(pool, orgId);
    const objective = LATENCY_OBJECTIVES.find((o) => o.name === OBJECTIVE_NAME);
    if (objective === undefined) {
      console.error(`REFUSED: the PRD objective ${OBJECTIVE_NAME} no longer exists.`);
      process.exitCode = 1;
      return;
    }

    const floor = await networkFloor(pool, 2_000);
    log(
      `network floor: a bare SELECT 1 at concurrency 1 is p50=${floor.p50?.toFixed(2)}ms.` +
        " Nothing below can be a real statement.",
    );

    console.log(`shape    : ${describeShape(SHAPE)}`);
    console.log(`objective: ${OBJECTIVE_NAME} ≤ ${objective.target}${objective.unit}`);
    console.log(`page size: ${RUN_CONDITIONS.payload.listPageSize} (declared)\n`);

    const workloads = inventoryBudgets();
    const watcher = concurrencyWatcher(observer);

    const driven = [];
    const notDriven = [];

    for (const budget of workloads) {
      const params = budget.params(fixtures);
      const rows = rowCounts.get(budget.rowCountSql) ?? 0;
      if (params === null) {
        notDriven.push({ id: budget.id, reason: "the cursor fixture this shape pages from does not exist" });
        continue;
      }
      if (rows < budget.minRows) {
        notDriven.push({
          id: budget.id,
          reason: `the tenant holds ${rows} row(s), below the budget's own minRows of ${budget.minRows}`,
        });
        continue;
      }

      const scoped = { ...budget, orgId };
      log(`warming ${budget.id}`);
      await driveWindow(pool, scoped, params, 2, SHAPE.warmupMs);
      log(`driving ${budget.id} at concurrency ${SHAPE.concurrency}`);
      watcher.reset();
      const sustained = await driveWindow(pool, scoped, params, SHAPE.concurrency, SHAPE.durationMs);
      const sustainedPeak = watcher.peak();
      const burst = await driveWindow(
        pool,
        scoped,
        params,
        SHAPE.concurrency * SHAPE.burstMultiplier,
        SHAPE.burstDurationMs,
      );

      const sustainedSummary = summarise(sustained.samples);
      const burstSummary = summarise(burst.samples);
      const decision = judge({ percentileKey: "p95", target: objective.target }, sustainedSummary);
      driven.push({
        id: budget.id,
        rows,
        samples: sustained.samples.length + burst.samples.length,
        errors: sustained.errors.length + burst.errors.length,
        firstError: sustained.errors[0] ?? burst.errors[0] ?? null,
        verdict: decision.verdict,
        p95: sustainedSummary.p95,
        p50: sustainedSummary.p50,
        p99: sustainedSummary.p99,
        burstP95: burstSummary.p95,
        sustainedRps: achievedRate(sustained.samples.length, SHAPE.durationMs),
        burstRps: achievedRate(burst.samples.length, SHAPE.burstDurationMs),
        observedConcurrency: sustainedPeak,
      });
    }

    await watcher.stop();

    const run = {
      role: String(effective?.current_user),
      bypassRls,
      workloadCount: workloads.length,
      concurrency: SHAPE.concurrency,
      observedConcurrency: weakestConcurrency(driven),
      target: objective.target,
      networkFloorP50: floor.p50,
      orgId,
      shape: SHAPE,
      driven,
      notDriven,
      conditions: RUN_CONDITIONS,
      measuredAt: new Date().toISOString(),
    };
    report(run);
    writeFileSync(OUT, JSON.stringify(run, null, 2));
    console.log(`\nWrote ${OUT}`);
  } finally {
    await Promise.all([pool.end(), observer.end()]);
  }
}

function report(run) {
  console.log("\nInventory read shapes under concurrency\n");
  for (const w of run.driven) {
    console.log(
      `${w.verdict.padEnd(11)} ${w.id.padEnd(30)} ` +
        `p50=${w.p50?.toFixed(1)}ms p95=${w.p95?.toFixed(1)}ms p99=${w.p99?.toFixed(1)}ms ` +
        `burst-p95=${w.burstP95?.toFixed(1)}ms · ${w.samples} samples ` +
        `${w.sustainedRps.toFixed(0)}/${w.burstRps.toFixed(0)} rps · ${w.rows} tenant rows` +
        (w.errors ? ` · ${w.errors} ERRORS` : ""),
    );
  }
  for (const w of run.notDriven) console.log(`NOT_DRIVEN  ${w.id.padEnd(30)} ${w.reason}`);

  console.log(
    `\nConcurrency observed: the weakest sustained window peaked at ${run.observedConcurrency}` +
      ` active backends against a requested ${run.concurrency}` +
      ` (floor ${MIN_OBSERVED_CONCURRENCY(run.concurrency)}). Per workload: ` +
      run.driven.map((w) => `${w.id}=${w.observedConcurrency}`).join(" "),
  );
  console.log(
    `Measured as ${run.role}${run.bypassRls ? " WITH BYPASSRLS — every figure above is a fiction" : ", RLS enforced"}.`,
  );

  const verdict = verdictFor(run);
  if (verdict.ok) {
    console.log(
      `\nPASSED: ${run.driven.length} of ${run.workloadCount} inventory read shapes driven` +
        ` concurrently, ${run.notDriven.length} not driven for a named reason, 0 errors,` +
        ` every p95 inside the ${run.target}ms objective.`,
    );
    return;
  }
  console.log(`\nFAILED (${verdict.failures.length})`);
  for (const f of verdict.failures) console.log(`  ${f}`);
  process.exitCode = 1;
}

await main();
