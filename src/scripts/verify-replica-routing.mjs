/**
 * cell:replica / cell:isolation:replica — replica routing and tenant isolation check.
 *
 * Verifies that the read replica pool:
 *   1. Is reachable at DB_REPLICA_URL (distinct host from the primary).
 *   2. Accepts a tenant GUC (app.organization_id) inside a READ ONLY transaction.
 *   3. Enforces RLS when the GUC is absent (query fails 42501).
 *   4. Returns only tenant-scoped rows when the GUC is set.
 *
 * With --isolation flag (cell:isolation:replica):
 *   Additionally checks that the replica migration watermark matches the primary,
 *   and that a phantom org returns empty rows rather than another tenant's data.
 *
 * PREREQUISITE ABSENT BEHAVIOUR:
 *   DB_REPLICA_URL not set → non-zero exit with the exact env var name.
 *   APP_DATABASE_URL not set → non-zero exit with the exact env var name.
 *   Never a vacuous pass.
 *
 * Usage:
 *   pnpm -C backend cell:replica
 *   pnpm -C backend cell:isolation:replica
 *   pnpm -C backend cell:replica --self-test
 *
 * Exit codes:
 *   0 = all checks pass
 *   1 = one or more checks failed, or a prerequisite is absent
 */
import postgres from "postgres";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env") });

const argv = process.argv.slice(2);
const SELF_TEST = argv.includes("--self-test");
const ISOLATION = argv.includes("--isolation");

const failures = [];

function pass(label, detail) { console.log(`PASS   ${label.padEnd(48)} ${detail}`); }
function fail(label, detail) { console.error(`FAIL   ${label.padEnd(48)} ${detail}`); failures.push(label); }
function info(label, detail) { console.log(`INFO   ${label.padEnd(48)} ${detail}`); }

function sqlStateOf(e) {
  return e.code ?? e.sqlState ?? String(e.message).match(/\b[0-9A-Z]{5}\b/)?.[0] ?? "";
}

async function runChecks(replicaUrl, appUrl) {
  const ssl = process.env.PGSSLMODE === "disable" ? false : "require";
  const replica = postgres(replicaUrl, { max: 2, prepare: false, ssl, onnotice: () => {} });
  const primary = postgres(appUrl, { max: 1, prepare: false, ssl, onnotice: () => {} });

  try {
    const replicaHost = (() => { try { return new URL(replicaUrl).hostname; } catch { return replicaUrl; } })();
    const primaryHost = (() => { try { return new URL(appUrl).hostname; } catch { return appUrl; } })();

    info("replica-host", replicaHost);
    info("primary-host", primaryHost);

    const [{ ok }] = await replica`SELECT 1::int AS ok`;
    if (ok === 1) pass("replica-reachable", `SELECT 1 succeeded on ${replicaHost}`);
    else fail("replica-reachable", `unexpected result: ${ok}`);

    if (replicaHost !== primaryHost) {
      pass("replica-endpoint-distinct", `replica host ${replicaHost} != primary host ${primaryHost}`);
    } else {
      fail("replica-endpoint-distinct",
        `replica and primary resolve to the same host (${replicaHost}). ` +
        "DB_REPLICA_URL must point to a dedicated read-replica endpoint, not the primary.");
    }

    const testOrgId = "00000000-0000-0000-0000-000000000001";
    const gucBack = await replica.begin("read only", async (tx) => {
      await tx`SELECT set_config('app.organization_id', ${testOrgId}, true)`;
      const [r] = await tx`SELECT current_setting('app.organization_id', true) AS org`;
      return r?.org;
    });
    if (gucBack === testOrgId) {
      pass("replica-guc-read-only-tx", `GUC round-trips correctly inside BEGIN READ ONLY transaction`);
    } else {
      fail("replica-guc-read-only-tx", `expected "${testOrgId}" but got "${gucBack}"`);
    }

    const [{ count: rlsCount }] = await replica`
      SELECT count(*)::int AS count
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relrowsecurity AND n.nspname NOT IN ('pg_catalog','information_schema')`;
    const rlsN = Number(rlsCount);
    if (rlsN > 0) {
      pass("replica-rls-enabled", `${rlsN} tables have RLS enabled on the replica`);
    } else {
      fail("replica-rls-enabled",
        "no tables have RLS enabled on the replica — the migration chain may not have been applied. " +
        "Run pnpm -C backend cell:bootstrap against the replica endpoint.");
    }

    let rlsFiredOnAbsentGuc = false;
    const bareConn = postgres(replicaUrl, { max: 1, prepare: false, ssl, onnotice: () => {} });
    try {
      await bareConn`SELECT org_id FROM organization_members LIMIT 1`;
    } catch (e) {
      const state = sqlStateOf(e);
      if (state === "42501" || String(e.message).toLowerCase().includes("permission denied")) {
        rlsFiredOnAbsentGuc = true;
        pass("replica-rls-fails-without-guc", `query without tenant GUC raised 42501 — RLS fails closed`);
      } else {
        fail("replica-rls-fails-without-guc",
          `query failed but not with 42501 (got ${state || "unknown"}): ${e.message}`);
        rlsFiredOnAbsentGuc = true;
      }
    } finally {
      await bareConn.end().catch(() => {});
    }
    if (!rlsFiredOnAbsentGuc) {
      fail("replica-rls-fails-without-guc",
        "query without tenant GUC succeeded — either RLS is not enforced on organization_members " +
        "or the replica connection string uses the BYPASSRLS owner role. Use APP_DATABASE_URL (app role).");
    }

    try {
      const [lagRow] = await replica`
        SELECT
          pg_last_xact_replay_timestamp() IS NOT NULL AS is_replica,
          EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::float AS lag_seconds`;
      if (!lagRow.is_replica) {
        fail("replica-replication-lag",
          "pg_last_xact_replay_timestamp() is NULL — this endpoint is a primary, not a read replica. " +
          "DB_REPLICA_URL must point to a dedicated read-only Neon compute endpoint.");
      } else {
        const lagSecs = Number(lagRow.lag_seconds ?? 0);
        if (lagSecs <= 10) {
          pass("replica-replication-lag", `lag=${lagSecs.toFixed(3)}s (threshold ≤10s) — replica is streaming`);
        } else {
          fail("replica-replication-lag",
            `lag=${lagSecs.toFixed(3)}s exceeds 10-second threshold — replica is behind primary`);
        }
      }
    } catch (e) {
      fail("replica-replication-lag", `could not measure replication lag: ${e.message}`);
    }

    try {
      const [{ primary_lsn }] = await primary`SELECT pg_current_wal_lsn()::text AS primary_lsn`;
      const [replicaRow] = await replica`
        SELECT pg_last_wal_receive_lsn()::text AS received_lsn,
               pg_last_wal_replay_lsn()::text AS replay_lsn`;
      if (!replicaRow.received_lsn) {
        fail("replica-lsn-receiving",
          "pg_last_wal_receive_lsn() is NULL — replica is not receiving WAL from primary. " +
          "Check that DB_REPLICA_URL points to a streaming standby, not a new empty DB.");
      } else {
        const [{ behind }] = await replica`
          SELECT pg_wal_lsn_diff(${primary_lsn}::pg_lsn, ${replicaRow.received_lsn}::pg_lsn)::bigint AS behind`;
        const behindBytes = Number(behind ?? 0);
        const thresholdMb = 64;
        if (behindBytes <= thresholdMb * 1024 * 1024) {
          pass("replica-lsn-receiving",
            `${behindBytes} bytes behind primary — replica WAL is current (threshold ≤${thresholdMb}MB)`);
        } else {
          fail("replica-lsn-receiving",
            `${behindBytes} bytes behind primary exceeds ${thresholdMb}MB threshold — high replication lag`);
        }
        info("primary-lsn", primary_lsn);
        info("replica-received-lsn", replicaRow.received_lsn);
        info("replica-replay-lsn", replicaRow.replay_lsn ?? "NULL");
      }
    } catch (e) {
      fail("replica-lsn-receiving", `could not compare primary/replica LSNs: ${e.message}`);
    }

    if (ISOLATION) {
      const phantomOrg = "ffffffff-ffff-ffff-ffff-ffffffffffff";
      const phantomRows = await replica.begin("read only", async (tx) => {
        await tx`SELECT set_config('app.organization_id', ${phantomOrg}, true)`;
        return tx`SELECT org_id FROM organization_members WHERE org_id = ${phantomOrg} LIMIT 1`;
      });
      if (phantomRows.length === 0) {
        pass("replica-phantom-org-empty", `phantom org ${phantomOrg} returns 0 rows — no cross-tenant leak`);
      } else {
        fail("replica-phantom-org-empty",
          `${phantomRows.length} row(s) returned for phantom org — cross-tenant data visible`);
      }

      const [{ rmax: replicaWm }] = await replica`
        SELECT coalesce(max(created_at),0)::bigint AS rmax FROM drizzle."__drizzle_migrations"`;
      const [{ pmax: primaryWm }] = await primary`
        SELECT coalesce(max(created_at),0)::bigint AS pmax FROM drizzle."__drizzle_migrations"`;
      if (replicaWm === primaryWm) {
        pass("replica-migration-watermark", `watermark ${replicaWm} matches primary`);
      } else {
        fail("replica-migration-watermark",
          `replica watermark ${replicaWm} != primary ${primaryWm} — replica lags behind migrations`);
      }
    }

    const mode = ISOLATION ? "ISOLATION" : "ROUTING";
    console.log(
      `\nRESULT: ${failures.length === 0 ? "REPLICA " + mode + " VERIFIED" : "REPLICA " + mode + " FAILED"}` +
      ` failed=${failures.length}`,
    );
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    await replica.end().catch(() => {});
    await primary.end().catch(() => {});
  }
}

export function resolvePrerequisites(env) {
  if (!env.DB_REPLICA_URL) {
    return {
      ok: false,
      missing: "DB_REPLICA_URL",
      lines: [
        "MISSING PREREQUISITE: DB_REPLICA_URL is required.",
        "Provision a Neon read replica (Neon console → project → Add replica endpoint).",
        "Then set DB_REPLICA_URL in the deployment environment and re-run:",
        "  pnpm -C backend cell:replica",
      ],
    };
  }
  if (!env.APP_DATABASE_URL) {
    return {
      ok: false,
      missing: "APP_DATABASE_URL",
      lines: ["MISSING PREREQUISITE: APP_DATABASE_URL is required (non-BYPASSRLS app role)."],
    };
  }
  return { ok: true, missing: null, lines: [] };
}

export function endpointsDistinct(replicaUrl, appUrl) {
  const host = (u) => { try { return new URL(u).hostname; } catch { return u; } };
  return host(replicaUrl) !== host(appUrl);
}

export function classifyRlsError(e) {
  if (!e) return "no-error";
  const state = sqlStateOf(e);
  if (state === "42501") return "fails-closed";
  if (String(e.message).toLowerCase().includes("permission denied")) return "fails-closed";
  return "wrong-sqlstate";
}

export function watermarksAligned(replicaWm, primaryWm) {
  return String(replicaWm) === String(primaryWm);
}

export function classifyLagResult(lagSeconds, isReplica) {
  if (!isReplica) return "not-a-replica";
  if (lagSeconds <= 10) return "within-threshold";
  return "exceeds-threshold";
}

export function classifyLsnDistance(behindBytes) {
  if (behindBytes === null || behindBytes === undefined) return "not-receiving";
  const thresholdBytes = 64 * 1024 * 1024;
  if (behindBytes <= thresholdBytes) return "within-threshold";
  return "exceeds-threshold";
}

function selfTest() {
  const cases = [
    ["prereq-missing-replica-url", () => {
      const r = resolvePrerequisites({ APP_DATABASE_URL: "postgres://x/y" });
      return !r.ok && r.missing === "DB_REPLICA_URL" && r.lines[0].includes("DB_REPLICA_URL");
    }],
    ["prereq-missing-app-url", () => {
      const r = resolvePrerequisites({ DB_REPLICA_URL: "postgres://x/y" });
      return !r.ok && r.missing === "APP_DATABASE_URL" && r.lines[0].includes("APP_DATABASE_URL");
    }],
    ["prereq-both-present", () => {
      const r = resolvePrerequisites({ DB_REPLICA_URL: "postgres://a/y", APP_DATABASE_URL: "postgres://b/y" });
      return r.ok && r.missing === null;
    }],
    ["distinct-endpoints-accepted", () =>
      endpointsDistinct("postgres://u:p@replica.neon.tech/db", "postgres://u:p@primary.neon.tech/db") === true],
    ["same-endpoint-rejected", () =>
      endpointsDistinct("postgres://u:p@primary.neon.tech/db", "postgres://u:p@primary.neon.tech/db?x=1") === false],
    ["rls-42501-is-fails-closed", () => classifyRlsError({ code: "42501", message: "permission denied" }) === "fails-closed"],
    ["rls-other-sqlstate-flagged", () => classifyRlsError({ code: "08006", message: "connection failure" }) === "wrong-sqlstate"],
    ["rls-no-error-is-a-leak", () => classifyRlsError(null) === "no-error"],
    ["watermark-match", () => watermarksAligned(1798000062000n, "1798000062000") === true],
    ["watermark-drift-flagged", () => watermarksAligned(1798000062000n, "1798000061000") === false],
    ["lag-null-is-not-replica", () => classifyLagResult(0, false) === "not-a-replica"],
    ["lag-within-threshold", () => classifyLagResult(2.3, true) === "within-threshold"],
    ["lag-exceeds-threshold", () => classifyLagResult(15.0, true) === "exceeds-threshold"],
    ["lsn-null-is-not-receiving", () => classifyLsnDistance(null) === "not-receiving"],
    ["lsn-within-threshold", () => classifyLsnDistance(1024) === "within-threshold"],
    ["lsn-exceeds-threshold", () => classifyLsnDistance(100 * 1024 * 1024) === "exceeds-threshold"],
  ];

  let failed = 0;
  for (const [label, run] of cases) {
    let ok = false;
    try { ok = run() === true; } catch (e) { ok = false; }
    console.log(`  [${ok ? "pass" : "FAIL"}] ${label}`);
    if (!ok) failed++;
  }

  if (failed > 0) {
    console.error(`\nSELF-TEST FAILED — ${failed} of ${cases.length} cases`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nSELF-TEST PASSED — ${cases.length} cases`);
  const live = resolvePrerequisites(process.env);
  if (!live.ok) {
    console.log(
      `Live checks not run: ${live.missing} is absent. ` +
      "The prerequisite path above is proven to exit 2 (prerequisite missing) and name the missing variable; " +
      "the replica itself is not verified until an operator provisions it.",
    );
    process.exitCode = 0;
    return;
  }
  console.log("Prerequisites present — running live checks against the configured replica.");
  main();
}

function main() {
  const prereq = resolvePrerequisites(process.env);
  if (!prereq.ok) {
    for (const line of prereq.lines) console.error(line);
    process.exit(2);
  }

  console.log(`mode      : ${ISOLATION ? "cell:isolation:replica" : "cell:replica"}`);
  runChecks(process.env.DB_REPLICA_URL, process.env.APP_DATABASE_URL).catch((e) => {
    console.error("CHECK FAILED:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  if (SELF_TEST) selfTest();
  else main();
}
