import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { loadEnv, parseCellArgs, redact } from "./cell-topology.mjs";
import { LATENCY_OBJECTIVES } from "./envelope-profile.mjs";
import {
  DEFAULT_SHAPE,
  RUN_CONDITIONS,
  TARGET_RATES,
  describeShape,
} from "./load-driver/load-profile.mjs";
import { achievedRate, judge, summarise } from "./load-driver/percentiles.mjs";
import {
  DRIVEN,
  NOT_DRIVEN_REASONS,
  PROBE_TABLE_DDL,
  PROBE_TABLE_DROP,
  crossOrgExposureProbe,
  measurePermissionRevocation,
  measureDurableEventLoss,
} from "./load-driver/workloads.mjs";

const env = loadEnv();
const argv = process.argv.slice(2);

if (argv.includes("--help")) {
  console.log(`
Drive the declared workload and report every PRD latency objective, measured or not driven.

  pnpm -C backend load:drive
  pnpm -C backend load:drive --concurrency=32 --duration=60000
  pnpm -C backend load:drive --self-test

Writes .load-driver-results.json for ticket 29's SLO feed and ticket 32's request-count unit.
An objective this run cannot exercise is reported NOT_DRIVEN with the reason, never estimated.
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
const OUT = resolve(process.cwd(), flag("out", ".load-driver-results.json"));

const started = Date.now();
const log = (m) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`);

function connect(url, max) {
  return postgres(url, { max, prepare: false, onnotice: () => {} });
}

async function resolveRedis() {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return {
    async ping() {
      const response = await fetch(`${url}/ping`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error(`cache responded ${response.status}`);
      await response.arrayBuffer();
    },
  };
}

async function networkBaseline(sql, durationMs) {
  const samples = [];
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    const t0 = process.hrtime.bigint();
    await sql`SELECT 1 AS ok`;
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return summarise(samples);
}

async function largestOrganization(sql) {
  const rows = await sql`
    SELECT org_id, count(*)::int AS members
    FROM organization_members GROUP BY org_id ORDER BY members DESC LIMIT 2`;
  return rows.map((r) => ({ orgId: String(r.org_id), members: Number(r.members) }));
}

async function driveWindow(name, workload, ctx, concurrency, durationMs) {
  const samples = [];
  const errors = [];
  const deadline = Date.now() + durationMs;
  const worker = async () => {
    while (Date.now() < deadline) {
      try {
        const ms = await workload.run(ctx);
        if (Number.isNaN(ms)) return;
        samples.push(ms);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
        if (errors.length > 20) return;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { name, samples, errors };
}

function selfTest() {
  const objective = { percentileKey: "p95", target: 10 };
  const met = judge(objective, summarise([1, 2, 3, 4, 5]));
  const breached = judge(objective, summarise([100, 200, 300]));
  const notDriven = judge(objective, summarise([]));

  const failures = [];
  if (met.verdict !== "MET") failures.push("a fast workload was not reported MET");
  if (breached.verdict !== "BREACHED")
    failures.push("a workload past its target was not reported BREACHED");
  if (notDriven.verdict !== "NOT_DRIVEN")
    failures.push("an unsampled objective was not reported NOT_DRIVEN");
  if (achievedRate(100, 1000) !== 100) failures.push("achieved rate is miscomputed");

  if (failures.length === 0) {
    console.log(
      "SELF-TEST PASS: a breach is reported as BREACHED and an unsampled objective as" +
        " NOT_DRIVEN — the guard can fail",
    );
    return;
  }
  for (const f of failures) console.error(`SELF-TEST FAIL: ${f}`);
  process.exitCode = 1;
}

async function main() {
  if (SELF_TEST) return selfTest();

  const topology = parseCellArgs(argv, env);
  const source = connect(topology.controlPlane.app ?? topology.controlPlane.owner, SHAPE.concurrency);
  const target = connect(topology.cell.app ?? topology.cell.owner, SHAPE.concurrency);
  const owner = connect(topology.cell.ownerDirect, 1);
  const discovery = connect(topology.controlPlane.ownerDirect, 1);

  console.log(`database : ${redact(topology.controlPlane.ownerDirect)}`);
  console.log(`probe    : ${redact(topology.cell.ownerDirect)}`);
  console.log(`shape    : ${describeShape(SHAPE)}`);
  console.log(`targets  : sustained ${TARGET_RATES.sustainedRps} rps, burst ${TARGET_RATES.burstRps} rps per cell\n`);

  const results = {};
  let totalRequests = 0;

  try {
    const orgs = await largestOrganization(discovery);
    const primary = orgs[0];
    if (primary === undefined) {
      console.error("REFUSED: no organization has any members; there is nothing to drive.");
      process.exitCode = 1;
      return;
    }
    log(`driving organization ${primary.orgId} with ${primary.members} member(s)`);

    for (const statement of PROBE_TABLE_DDL) await owner.unsafe(statement);
    log("probe table created in the cell, RLS enabled");

    const baseline = await networkBaseline(discovery, 3_000);
    log(
      `network floor: a bare SELECT 1 at concurrency 1 is p50=${baseline.p50.toFixed(1)}ms` +
        ` p95=${baseline.p95.toFixed(1)}ms. Nothing below can measure faster than this.`,
    );

    const redis = await resolveRedis();
    log(redis === null ? "cache not configured — redis objective will be NOT_DRIVEN" : "cache configured");

    const ctx = {
      sql: source,
      target,
      orgId: primary.orgId,
      pageSize: RUN_CONDITIONS.payload.listPageSize,
      redis,
    };

    for (const [name, workload] of Object.entries(DRIVEN)) {
      log(`warming ${name}`);
      await driveWindow(name, workload, ctx, 2, SHAPE.warmupMs);
      log(`driving ${name} at concurrency ${SHAPE.concurrency}`);
      const sustained = await driveWindow(
        name,
        workload,
        ctx,
        SHAPE.concurrency,
        SHAPE.durationMs,
      );
      const burst = await driveWindow(
        name,
        workload,
        ctx,
        SHAPE.concurrency * SHAPE.burstMultiplier,
        SHAPE.burstDurationMs,
      );
      results[name] = {
        description: workload.description,
        sustained: summarise(sustained.samples),
        burst: summarise(burst.samples),
        errors: sustained.errors.length + burst.errors.length,
        firstError: sustained.errors[0] ?? burst.errors[0] ?? null,
      };
      totalRequests += sustained.samples.length + burst.samples.length;
    }

    const other = orgs[1];
    const exposure =
      other === undefined
        ? null
        : await crossOrgExposureProbe(source, primary.orgId, other.orgId);
    results["cross-org-data-exposure"] = {
      description: "rows of one organization visible while the tenant GUC names another",
      rowsVisible: exposure,
    };

    log("measuring permission revocation end-to-end (DB level)");
    results["permission-revocation-explicit"] = {
      description: "grant inserted, confirmed, revoked in one transaction, confirmed gone in next read",
      ...(await measurePermissionRevocation(discovery, primary.orgId)),
    };

    log("measuring durable event loss after induced abort");
    results["durable-event-loss-after-ack"] = {
      description: "outbox events inserted PENDING, ack transaction aborted, surviving PENDING counted",
      ...(await measureDurableEventLoss(discovery, primary.orgId)),
    };

    report(results, totalRequests, primary, baseline);
  } finally {
    await owner.unsafe(PROBE_TABLE_DROP).catch(() => {});
    await Promise.all([source.end(), target.end(), owner.end(), discovery.end()]);
  }
}

function report(results, totalRequests, primary, baseline) {
  console.log("\nLatency objectives\n");
  let measured = 0;
  let breached = 0;
  const objectives = [];

  for (const objective of LATENCY_OBJECTIVES) {
    const driven = DRIVEN[objective.name];
    const result = results[objective.name];

    if (objective.name === "cross-org-data-exposure") {
      const rows = result?.rowsVisible;
      const ok = rows === 0;
      const verdict = rows === null ? "NOT_DRIVEN" : ok ? "MET" : "BREACHED";
      if (rows !== null) measured += 1;
      if (verdict === "BREACHED") breached += 1;
      console.log(
        `${verdict.padEnd(11)} ${objective.name.padEnd(38)} ` +
          (rows === null
            ? "only one organization has members; nothing to cross"
            : `${rows} row(s) visible across the tenant boundary (target ${objective.target})`),
      );
      objectives.push({ name: objective.name, verdict, measured: rows, target: objective.target });
      continue;
    }

    if (objective.name === "permission-revocation-explicit") {
      if (result?.error) {
        console.log(`NOT_DRIVEN  ${objective.name.padEnd(38)} ${result.error}`);
        objectives.push({ name: objective.name, verdict: "NOT_DRIVEN", reason: result.error, target: objective.target });
        continue;
      }
      const elapsedMs = result?.elapsedMs;
      if (elapsedMs === undefined) {
        console.log(`NOT_DRIVEN  ${objective.name.padEnd(38)} no measurement produced`);
        objectives.push({ name: objective.name, verdict: "NOT_DRIVEN", target: objective.target });
        continue;
      }
      const verdict = elapsedMs <= objective.target ? "MET" : "BREACHED";
      measured += 1;
      if (verdict === "BREACHED") breached += 1;
      console.log(
        `${verdict.padEnd(11)} ${objective.name.padEnd(38)} ` +
          `${elapsedMs.toFixed(0)}ms target=${objective.target}ms` +
          ` (DB floor: revoke tx + one confirming read; live app adds Redis and in-process cache delay)`,
      );
      objectives.push({ name: objective.name, verdict, measured: elapsedMs, target: objective.target });
      continue;
    }

    if (objective.name === "durable-event-loss-after-ack") {
      if (result?.error) {
        console.log(`NOT_DRIVEN  ${objective.name.padEnd(38)} ${result.error}`);
        objectives.push({ name: objective.name, verdict: "NOT_DRIVEN", reason: result.error, target: objective.target });
        continue;
      }
      const lost = result?.lost;
      if (lost === undefined) {
        console.log(`NOT_DRIVEN  ${objective.name.padEnd(38)} no measurement produced`);
        objectives.push({ name: objective.name, verdict: "NOT_DRIVEN", target: objective.target });
        continue;
      }
      const verdict = lost === 0 ? "MET" : "BREACHED";
      measured += 1;
      if (verdict === "BREACHED") breached += 1;
      console.log(
        `${verdict.padEnd(11)} ${objective.name.padEnd(38)} ` +
          `${lost} event(s) lost of ${result.acknowledged} acknowledged` +
          ` (ack tx aborted, ${result.remaining} remaining PENDING — target 0)`,
      );
      objectives.push({ name: objective.name, verdict, measured: lost, target: objective.target, acknowledged: result.acknowledged });
      continue;
    }

    if (driven === undefined || result === undefined) {
      const reason = NOT_DRIVEN_REASONS[objective.name] ?? "not exercised by this driver";
      console.log(`NOT_DRIVEN  ${objective.name.padEnd(38)} ${reason}`);
      objectives.push({ name: objective.name, verdict: "NOT_DRIVEN", reason, target: objective.target });
      continue;
    }

    const verdictInfo = judge({ ...objective, percentileKey: driven.percentileKey }, result.sustained);
    if (verdictInfo.verdict !== "NOT_DRIVEN") measured += 1;
    if (verdictInfo.verdict === "BREACHED") breached += 1;
    const s = result.sustained;
    console.log(
      `${verdictInfo.verdict.padEnd(11)} ${objective.name.padEnd(38)} ` +
        (s.count === 0
          ? NOT_DRIVEN_REASONS[objective.name] ?? "no samples"
          : `${driven.percentileKey}=${s[driven.percentileKey].toFixed(1)}ms ` +
            `target=${objective.target}${objective.unit.startsWith("ms") ? "ms" : ""} ` +
            `n=${s.count} p50=${s.p50.toFixed(1)} p99=${s.p99.toFixed(1)} max=${s.max.toFixed(1)}`),
    );
    objectives.push({
      name: objective.name,
      verdict: verdictInfo.verdict,
      measured: verdictInfo.measured,
      target: objective.target,
      samples: s.count,
      burst: result.burst,
      errors: result.errors,
    });
  }

  const durationMs = SHAPE.durationMs + SHAPE.burstDurationMs;
  const rate = achievedRate(totalRequests, durationMs * Object.keys(DRIVEN).length);

  console.log("\nAchieved rate against the envelope\n");
  console.log(`  requests completed        ${totalRequests}`);
  console.log(`  achieved                  ${rate.toFixed(1)} req/s`);
  console.log(`  per-cell sustained target ${TARGET_RATES.sustainedRps} req/s`);
  console.log(
    `  ratio                     ${((rate / TARGET_RATES.sustainedRps) * 100).toFixed(2)}% of target`,
  );
  console.log(`\n  ${TARGET_RATES.note}`);
  console.log(`  ${RUN_CONDITIONS.geography.note}`);

  writeFileSync(
    OUT,
    JSON.stringify(
      {
        generatedAtMs: Date.now(),
        requestCount: totalRequests,
        durationMs: durationMs * Object.keys(DRIVEN).length,
        achievedRps: rate,
        targetSustainedRps: TARGET_RATES.sustainedRps,
        organizationId: primary.orgId,
        organizationMembers: primary.members,
        networkFloorMs: { p50: baseline.p50, p95: baseline.p95 },
        shape: SHAPE,
        conditions: RUN_CONDITIONS,
        objectives,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(
    `\nRESULT: ${breached === 0 ? "NO OBJECTIVE BREACHED" : `${breached} OBJECTIVE(S) BREACHED`}` +
      ` measured=${measured}/${LATENCY_OBJECTIVES.length}` +
      ` not_driven=${LATENCY_OBJECTIVES.length - measured} results=${OUT}`,
  );
  if (breached > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("LOAD DRIVER FAILED:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
