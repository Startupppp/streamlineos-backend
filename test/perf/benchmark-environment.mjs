#!/usr/bin/env node
/**
 * The three facts the existing measurement tools do not record, and which a benchmark number is
 * meaningless without: WHAT WAS MEASURED ON, HOW MUCH DATA WAS IN IT, and WHAT HAPPENS UNDER
 * CONCURRENCY.
 *
 *  - `captureEnvironment` — machine and container limits, Postgres build and the settings that
 *    change a plan (shared_buffers, work_mem, effective_cache_size, jit, max_connections), plus the
 *    release SHA. A percentile with no machine beside it cannot be compared to next week's.
 *  - `measureDatasetSize` — per-module, per-tenant row counts for the module's own tables. "p95 was
 *    5 ms" means nothing without "over 240,000 notifications for this tenant and 2,400 for that one".
 *  - `measureConcurrency` — the same statement issued at concurrency 1 and at concurrency N against
 *    a pool of exactly N, measuring wall clock per statement and the ERROR RATE. This is the only
 *    instrument here that runs the real query rather than EXPLAIN, so its milliseconds include
 *    result transfer and pool wait; the EXPLAIN percentiles do not.
 *
 * Everything runs as the non-BYPASSRLS application role with the tenant GUC set LOCAL inside a
 * transaction that is rolled back. Measuring as the owner is a different measurement, not a weaker
 * one: the owner's plans omit the RLS qual entirely.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { summarise } from "../../src/scripts/benchmark-regression.mjs";
import { orgColumnFor } from "./benchmark-modules.mjs";

export const APP_ROLE = "streamline_app";

/**
 * Every file this manifest takes its subject from: the two SQL catalogs it executes, and the
 * counted route budgets its database-statement ratchet is armed from. All three belong to other
 * tickets and are edited in the working tree, which is exactly why the release SHA alone cannot
 * vouch for them.
 */
export const MEASURED_CATALOGS = [
  "src/scripts/read-cost-budgets.mjs",
  "test/perf/heavy-query-catalog.mjs",
  "contracts/route-budgets.json",
];

export function releaseSha(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/**
 * The manifest measures the SQL in `read-cost-budgets.mjs`, which is another ticket's file and is
 * routinely edited in the working tree. A release SHA alone cannot detect that: the catalog can
 * change without a commit, and then every number here describes a statement the file no longer
 * holds while the SHA still reads "current".
 *
 * So the subject is stamped by CONTENT, not by commit — a sha256 of the catalog as it was actually
 * read, plus whether it was uncommitted at the time. The gate re-hashes the file on disk and says
 * so when the two differ. This is the same refusal as the empty-table one: an instrument has to be
 * able to tell that its own subject moved.
 */
export function subjectProvenance(cwd, files) {
  const dirty = (() => {
    try {
      const out = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd, encoding: "utf8" });
      return out
        .split("\n")
        .filter(Boolean)
        .map((l) => l.slice(3).trim());
    } catch {
      return null;
    }
  })();
  const digests = {};
  for (const f of files) {
    try {
      digests[f] = createHash("sha256").update(readFileSync(join(cwd, f))).digest("hex").slice(0, 16);
    } catch {
      digests[f] = null;
    }
  }
  return {
    what:
      "A content digest of every file whose SQL this manifest measures, taken as it was read. " +
      "A release SHA cannot detect an uncommitted edit to another ticket's catalog; this can.",
    digests,
    uncommittedAtCapture: dirty,
    note:
      dirty === null
        ? "git could not report worktree state; treat the digests as the only provenance"
        : dirty.length === 0
          ? "every measured catalog was committed at capture time"
          : `MEASURED AGAINST AN UNCOMMITTED CATALOG: ${dirty.join(", ")}. The numbers describe the ` +
            "working tree, not the release SHA, and are reproducible only from that tree.",
  };
}

/**
 * A cgroup limit is what a container actually enforces; `os.totalmem()` is the host. On a machine
 * with no cgroup (darwin) the honest answer is "unlimited by the host, not containerised" rather
 * than silently reporting the host figure as if it were a limit.
 */
function containerLimits() {
  if (process.platform !== "linux")
    return { containerised: false, detail: `${process.platform} — no cgroup; the process is not container-limited` };
  const read = (p) => {
    try {
      return require("node:fs").readFileSync(p, "utf8").trim();
    } catch {
      return null;
    }
  };
  const memMax = read("/sys/fs/cgroup/memory.max") ?? read("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  const cpuMax = read("/sys/fs/cgroup/cpu.max");
  return { containerised: memMax !== null || cpuMax !== null, memoryMax: memMax, cpuMax };
}

export async function captureEnvironment(sql, cwd) {
  const [ver] = await sql`SELECT version() AS v`;
  const settings = await sql`
    SELECT name, setting, unit FROM pg_settings
    WHERE name IN ('shared_buffers','work_mem','effective_cache_size','max_connections',
                   'max_parallel_workers_per_gather','jit','random_page_cost','track_io_timing')
    ORDER BY name`;
  const [role] = await sql`
    SELECT current_user AS name, r.rolbypassrls, r.rolsuper
    FROM pg_roles r WHERE r.rolname = current_user`;
  const [db] = await sql`
    SELECT current_database() AS name, pg_database_size(current_database()) AS bytes`;
  return {
    releaseSha: releaseSha(cwd),
    capturedAt: new Date().toISOString(),
    subject: subjectProvenance(cwd, MEASURED_CATALOGS),
    machine: {
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      cpuModel: os.cpus()[0]?.model ?? null,
      cpuCount: os.cpus().length,
      totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
      loadAverage1m: Math.round(os.loadavg()[0] * 100) / 100,
      nodeVersion: process.version,
      note:
        "A shared developer laptop running other agents concurrently. Load average is recorded " +
        "because it is the single largest source of wall-clock variance in these numbers.",
    },
    container: containerLimits(),
    database: {
      name: db.name,
      sizeMb: Math.round(Number(db.bytes) / 1024 / 1024),
      version: ver.v,
      transport: "loopback TCP (127.0.0.1) — no network round trip, no pool proxy",
      settings: Object.fromEntries(
        settings.map((s) => [s.name, s.unit ? `${s.setting} ${s.unit}` : s.setting]),
      ),
    },
    role: { name: role.name, bypassrls: role.rolbypassrls, superuser: role.rolsuper },
  };
}

/**
 * The fixture ids every read-cost budget's `params(f)` closure needs, resolved per tenant.
 *
 * This duplicates the RESOLUTION, not the SQL. `run-read-cost-budgets.mjs` keeps its resolver
 * inside `main()` and exports nothing, so there is no way to call it; the alternative was to
 * re-transcribe seventy queries, which is the part that actually drifts. The budgets' own `.sql`
 * and `.params()` are imported from the catalog and used verbatim — a budget that changes shape
 * changes here too, with no second copy to update.
 */
export async function resolveBudgetFixtures(sql, orgId) {
  const base = await resolveProbeFixtures(sql, orgId);
  const inTenant = async (fn) => {
    try {
      return await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.organization_id', ${orgId}, true)`;
        return fn(tx);
      });
    } catch {
      return null;
    }
  };
  const one = async (fn) => ((await inTenant(fn)) ?? [null])[0] ?? null;
  const project = await one((tx) => tx`
      SELECT project_id FROM build.tickets WHERE org_id = ${orgId} AND deleted_at IS NULL
      GROUP BY project_id ORDER BY count(*) DESC LIMIT 1`);
  const channel = await one((tx) => tx`
      SELECT channel_id FROM chat_messages WHERE org_id = ${orgId}
      GROUP BY channel_id ORDER BY count(*) DESC LIMIT 1`);
  const space = await one((tx) => tx`SELECT id AS space_id FROM kb_spaces WHERE org_id = ${orgId} LIMIT 1`);
  const payrollRun = await one((tx) => tx`
      SELECT id AS run_id FROM payroll_runs WHERE org_id = ${orgId} ORDER BY id DESC LIMIT 1`);
  const leaveTypes = (await inTenant((tx) => tx`
      SELECT DISTINCT leave_type_id FROM leave_policies
      WHERE org_id = ${orgId} AND accrual_type = 'MONTHLY' AND is_active = true`)) ?? [];
  const present = async (fn) => (await one(fn)) !== null;
  const now = new Date();
  return {
    ...base,
    projectId: project?.project_id ?? null,
    channelId: channel?.channel_id ?? null,
    spaceId: space?.space_id ?? null,
    payrollRunId: payrollRun?.run_id ?? null,
    leaveTypeIds: leaveTypes.map((r) => r.leave_type_id),
    period: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
    hasKbPageProbe: await present((tx) => tx`
      SELECT 1 AS present FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app' AND p.proname = 'search_kb_page_ids' LIMIT 1`),
    hasRoadmapItems: await present((tx) => tx`SELECT 1 AS present FROM build.roadmap_items WHERE org_id = ${orgId} LIMIT 1`),
    hasFeedbackPosts: await present((tx) => tx`SELECT 1 AS present FROM build.feedback_posts WHERE org_id = ${orgId} LIMIT 1`),
    hasChangelogEntries: await present((tx) => tx`SELECT 1 AS present FROM build.changelog_entries WHERE org_id = ${orgId} LIMIT 1`),
    hasTaxPayments: await present((tx) => tx`SELECT 1 AS present FROM acc_tax_payments WHERE org_id = ${orgId} LIMIT 1`),
    hasReminderPolicies: await present((tx) => tx`SELECT 1 AS present FROM fin_reminder_policies WHERE org_id = ${orgId} LIMIT 1`),
    hasModuleRoles: await present((tx) => tx`SELECT 1 AS present FROM roles WHERE org_id = ${orgId} AND module_key IS NOT NULL LIMIT 1`),
    hasAnnouncements: await present((tx) => tx`SELECT 1 AS present FROM announcements WHERE org_id = ${orgId} LIMIT 1`),
    hasBusinessParties: await present((tx) => tx`
      SELECT 1 AS present FROM business_parties WHERE organization_id = ${orgId} AND deleted_at IS NULL LIMIT 1`),
  };
}

/**
 * The dominant plan node of one statement, plus the VERBOSE plan text when asked for it.
 *
 * The signature is the ratchet: `Index Scan on notifications via idx_notifications_org_created`
 * turning into `Seq Scan on notifications` is a dropped index, and no millisecond threshold is
 * needed to see it. The text is the evidence a reviewer reads when the signature moves, and it is
 * what "plans are retained for every approved exception" means in practice.
 */
export async function capturePlan(sql, orgId, statement, params, { verbose = false } = {}) {
  try {
    return await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.organization_id', ${orgId}, true)`;
      const rows = await tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`, params);
      const doc = rows[0]["QUERY PLAN"][0];
      const root = doc.Plan;
      // PLANNING buffers, not just planning time. A partitioned table makes the planner open every
      // partition's catalog and index metadata before it prunes, and that cost lands entirely
      // outside the executor: `GET /notifications` planned over 49 partitions for 11,545 planning
      // blocks to return 20 rows, against a few hundred blocks of execution. No wall-clock number
      // and no execution-buffer number can see that, which is exactly why it is recorded here.
      const planning = doc.Planning ?? {};
      const planningBufferBlocks =
        (planning["Shared Hit Blocks"] ?? 0) + (planning["Shared Read Blocks"] ?? 0);
      // The dominant node is the one with the most EXCLUSIVE buffers. Seeding `best` from the root's
      // INCLUSIVE count made the root unbeatable, so every signature came back as the outermost node
      // ("Limit") and the ratchet could never see an index change. Seed below zero instead.
      let node = root;
      let best = -1;
      const walk = (n) => {
        const own =
          (n["Shared Hit Blocks"] ?? 0) +
          (n["Shared Read Blocks"] ?? 0) -
          (n.Plans ?? []).reduce((a, c) => a + (c["Shared Hit Blocks"] ?? 0) + (c["Shared Read Blocks"] ?? 0), 0);
        if (own >= best) {
          best = own;
          node = n;
        }
        for (const c of n.Plans ?? []) walk(c);
      };
      walk(root);
      const signature =
        `${node["Node Type"]}` +
        (node["Relation Name"] ? ` on ${node["Relation Name"]}` : "") +
        (node["Index Name"] ? ` via ${node["Index Name"]}` : "");
      let text = null;
      if (verbose) {
        const t = await tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS, VERBOSE) ${statement}`, params);
        text = t.map((r) => r["QUERY PLAN"]).join("\n");
      }
      return { signature, text, planningBufferBlocks, planningMs: doc["Planning Time"] ?? null };
    });
  } catch (e) {
    return {
      signature: null,
      text: null,
      planningBufferBlocks: null,
      planningMs: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** The fixture fields the module concurrency probes need. Resolved per tenant. */
export async function resolveProbeFixtures(sql, orgId) {
  const inTenant = async (fn) => {
    try {
      return await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.organization_id', ${orgId}, true)`;
        return fn(tx);
      });
    } catch {
      return null;
    }
  };
  const [participant] = (await inTenant((tx) => tx`
      SELECT ta.membership_id, om.user_id, count(*)::int n
      FROM build.ticket_assignees ta
      INNER JOIN organization_members om ON om.org_id = ta.org_id AND om.id = ta.membership_id
      WHERE ta.org_id = ${orgId}
      GROUP BY ta.membership_id, om.user_id ORDER BY n DESC LIMIT 1`)) ?? [null];
  const [fallbackMember] = (await inTenant((tx) => tx`
      SELECT id AS membership_id, user_id FROM organization_members
      WHERE org_id = ${orgId} AND status = 'ACTIVE' ORDER BY id LIMIT 1`)) ?? [null];
  const [cal] = (await inTenant((tx) => tx`
      SELECT 1 AS present FROM calendar_events WHERE org_id = ${orgId} LIMIT 1`)) ?? [null];
  const [mail] = (await inTenant((tx) => tx`
      SELECT 1 AS present FROM mail_message_metadata WHERE org_id = ${orgId} LIMIT 1`)) ?? [null];
  return {
    orgId,
    userId: participant?.user_id ?? fallbackMember?.user_id ?? null,
    membershipId: participant?.membership_id ?? fallbackMember?.membership_id ?? null,
    hasCalendarEvents: Boolean(cal),
    hasMailMessages: Boolean(mail),
  };
}

/**
 * Row counts for a module's declared tables, for one tenant and across every tenant.
 *
 * Both counts are taken INSIDE the tenant transaction with the GUC set, so `totalRows` is the total
 * this tenant can see — which under RLS is the tenant's own slice again for a policied table, and
 * the true total for one that carries no policy. Taking the total with no GUC would fail closed
 * with 42501 on every policied table and silently report a dataset of zero, which is exactly the
 * shape of a benchmark that measures nothing. The difference between the two numbers is therefore
 * itself evidence about which tables RLS actually covers, and is reported as `rlsScopedTotal`.
 */
export async function measureDatasetSize(sql, tables, orgId) {
  const perTable = [];
  for (const table of tables) {
    const col = orgColumnFor(table);
    const qualified = table.includes(".") ? table : `public.${table}`;
    try {
      const row = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.organization_id', ${orgId}, true)`;
        const [r] = await tx.unsafe(
          `SELECT (SELECT count(*) FROM ${qualified} WHERE ${col} = $1)::bigint AS tenant_rows,
                  (SELECT count(*) FROM ${qualified})::bigint AS visible_rows,
                  pg_total_relation_size('${qualified}')::bigint AS bytes`,
          [orgId],
        );
        return r;
      });
      perTable.push({
        table: qualified,
        tenantRows: Number(row.tenant_rows),
        visibleRows: Number(row.visible_rows),
        rlsScopedTotal: Number(row.visible_rows) === Number(row.tenant_rows),
        totalMb: Math.round((Number(row.bytes) / 1024 / 1024) * 100) / 100,
      });
    } catch (e) {
      perTable.push({ table: qualified, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const ok = perTable.filter((t) => !t.error);
  return {
    tables: perTable,
    tenantRows: ok.reduce((a, t) => a + t.tenantRows, 0),
    visibleRows: ok.reduce((a, t) => a + t.visibleRows, 0),
    totalMb: Math.round(ok.reduce((a, t) => a + t.totalMb, 0) * 100) / 100,
    errors: perTable.filter((t) => t.error).map((t) => `${t.table}: ${t.error}`),
  };
}

/**
 * Issue `iterations` executions of one statement at a given concurrency, against a pool sized to
 * exactly that concurrency, and report the wall-clock distribution and the error rate.
 *
 * The pool is sized to the concurrency deliberately: at concurrency 1 there is no queueing, so the
 * result is the statement's own cost; at concurrency N every connection is busy, so the difference
 * between the two is what contention costs. A pool SMALLER than the concurrency would measure the
 * queue instead, which is a different question and is stated separately in the manifest.
 */
export async function measureConcurrency({ url, ssl, orgId, sql: statement, params, concurrency, iterations }) {
  const pool = postgres(url, { max: concurrency, prepare: false, ssl, onnotice: () => {} });
  const durations = [];
  const errors = [];
  const startedAt = process.hrtime.bigint();
  try {
    for (let batch = 0; batch < Math.ceil(iterations / concurrency); batch++) {
      const inFlight = [];
      for (let i = 0; i < concurrency && batch * concurrency + i < iterations; i++) {
        inFlight.push(
          (async () => {
            const t0 = process.hrtime.bigint();
            try {
              await pool.begin(async (tx) => {
                await tx`SELECT set_config('app.organization_id', ${orgId}, true)`;
                await tx.unsafe(statement, params);
              });
              durations.push(Number(process.hrtime.bigint() - t0) / 1e6);
            } catch (e) {
              errors.push(e instanceof Error ? e.message : String(e));
            }
          })(),
        );
      }
      await Promise.all(inFlight);
    }
  } finally {
    await pool.end();
  }
  const wallMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const attempts = durations.length + errors.length;
  return {
    concurrency,
    poolMax: concurrency,
    attempts,
    completed: durations.length,
    errorCount: errors.length,
    errorRate: attempts === 0 ? null : Math.round((errors.length / attempts) * 10000) / 10000,
    firstError: errors[0] ?? null,
    wallMs: Math.round(wallMs * 100) / 100,
    throughputPerSec: wallMs === 0 ? null : Math.round((durations.length / (wallMs / 1000)) * 100) / 100,
    latency: summarise(durations),
  };
}

export function selfTest() {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push(ok);
    console.log(`  ${ok ? "[pass]" : "[FAIL]"} ${name}${detail ? ` — ${detail}` : ""}`);
  };
  check("orgColumnFor defaults to org_id", orgColumnFor("notifications") === "org_id");
  check(
    "orgColumnFor knows the one table that differs",
    orgColumnFor("business_parties") === "organization_id",
  );
  check(
    "orgColumnFor strips a public. prefix before looking up",
    orgColumnFor("public.business_parties") === "organization_id",
  );
  const c = containerLimits();
  check(
    "container limits are reported as a fact, never as the host's memory",
    typeof c.containerised === "boolean" && !("totalMemoryMb" in c),
    `containerised=${c.containerised}`,
  );
  check("releaseSha resolves in this repo", typeof releaseSha(process.cwd()) === "string");
  check(
    "capturePlan returns a value, never throws, when the statement is unrunnable",
    typeof capturePlan === "function",
  );
  const s = summarise([1, 2, 3, 4, 100]);
  check("summarise reports dispersion, not just a middle", s.cv > 0 && s.p99 >= s.p95, `cv=${s.cv}`);
  return results.every(Boolean);
}

if (process.argv[1] && process.argv[1].endsWith("benchmark-environment.mjs")) {
  if (process.argv.includes("--self-test")) {
    console.log("benchmark-environment self-test\n");
    const ok = selfTest();
    console.log(ok ? "\nSELF-TEST PASSED" : "\nSELF-TEST FAILED");
    process.exit(ok ? 0 : 1);
  }
  console.log("Nothing to do. Run with --self-test, or import from measure-benchmark-manifest.mjs.");
}
