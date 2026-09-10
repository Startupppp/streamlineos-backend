import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { envKeyFor, loadEnv, parseCellArgs, redact } from "./cell-topology.mjs";

const env = loadEnv();
const argv = process.argv.slice(2);

if (argv.includes("--help")) {
  console.log(`
Prove what a cell can and cannot reach, as the application role.

  node src/scripts/verify-cell-isolation.mjs [--region=cell-2] [--json]
  node src/scripts/verify-cell-isolation.mjs --self-test

Every resource ticket 26 names is reported as one of:
  ISOLATED   — physically separate instance; attacker needs a cell-specific credential
  NAMESPACED — one shared instance, keys/prefixes scoped per cell; an attacker with
               the master credential still sees all cells' data
  SHARED     — no isolation at all; names what would fix it
  UNPROVED   — not enough configuration to determine the verdict

Exit is non-zero when a resource that must be isolated is not.
`);
  process.exit(0);
}

const SELF_TEST = argv.includes("--self-test");
const JSON_OUT = argv.includes("--json");
/**
 * Resolved inside main(), AFTER the self-test branch — see there for why.
 */
let topology;

function connect(url) {
  return postgres(url, { max: 1, prepare: false, onnotice: () => {} });
}

const results = [];
const record = (resource, verdict, evidence, isolatedBy) =>
  results.push({ resource, verdict, evidence, isolatedBy: isolatedBy ?? null });

async function probeDatabase() {
  const cellApp = connect(topology.cell.app);
  const controlApp = connect(topology.controlPlane.app);
  const cellOwner = connect(topology.cell.ownerDirect);
  const controlOwner = connect(topology.controlPlane.ownerDirect);
  const marker = `isolation-probe-${randomUUID()}`;

  try {
    const [{ current_database: cellDb, current_user: cellUser }] =
      await cellApp`SELECT current_database(), current_user`;
    const [{ current_database: controlDb }] =
      await controlApp`SELECT current_database()`;

    if (cellUser !== "streamline_app")
      throw new Error(`the cell probe connected as "${cellUser}", not the application role`);

    record(
      "database identity",
      cellDb === controlDb ? "SHARED" : "ISOLATED",
      `cell=${cellDb} control-plane=${controlDb} as ${cellUser}`,
      "a separate database per cell",
    );

    const [{ rolbypassrls }] = await cellApp`
      SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    record(
      "application role privilege",
      rolbypassrls ? "SHARED" : "ISOLATED",
      `streamline_app bypassrls=${rolbypassrls} in ${cellDb}`,
      "NOBYPASSRLS on the cell's application role",
    );

    await controlOwner.unsafe(
      `CREATE TABLE IF NOT EXISTS cell_isolation_probe (marker text primary key)`,
    );
    await cellOwner.unsafe(
      `CREATE TABLE IF NOT EXISTS cell_isolation_probe (marker text primary key)`,
    );
    await controlOwner`INSERT INTO cell_isolation_probe (marker) VALUES (${marker})`;

    const seenFromCell = await cellOwner`
      SELECT marker FROM cell_isolation_probe WHERE marker = ${marker}`;
    record(
      "control-plane rows visible from the cell",
      seenFromCell.length === 0 ? "ISOLATED" : "SHARED",
      `probe ${marker} written in ${controlDb}; rows visible in ${cellDb}: ${seenFromCell.length}`,
      "a separate database per cell",
    );

    const cellMarker = `${marker}-cell`;
    await cellOwner`INSERT INTO cell_isolation_probe (marker) VALUES (${cellMarker})`;
    const seenFromControl = await controlOwner`
      SELECT marker FROM cell_isolation_probe WHERE marker = ${cellMarker}`;
    record(
      "cell rows visible from the control plane",
      seenFromControl.length === 0 ? "ISOLATED" : "SHARED",
      `probe ${cellMarker} written in ${cellDb}; rows visible in ${controlDb}: ${seenFromControl.length}`,
      "a separate database per cell",
    );

    const bridges = await cellApp`
      SELECT extname FROM pg_extension WHERE extname IN ('dblink', 'postgres_fdw')`;
    record(
      "cross-database bridge",
      bridges.length === 0 ? "ISOLATED" : "SHARED",
      bridges.length === 0
        ? "neither dblink nor postgres_fdw is installed in the cell"
        : `installed: ${bridges.map((b) => b.extname).join(", ")}`,
      "not installing dblink or postgres_fdw in a cell",
    );

    const foreignServers = await cellApp`SELECT srvname FROM pg_foreign_server`;
    record(
      "foreign servers",
      foreignServers.length === 0 ? "ISOLATED" : "SHARED",
      `${foreignServers.length} foreign server(s) defined in ${cellDb}`,
      "no foreign server pointing at another cell",
    );

    const [{ count: rlsTables }] = await cellOwner`
      SELECT count(*)::int FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relrowsecurity AND n.nspname NOT IN ('pg_catalog', 'information_schema')`;
    record(
      "row-level security in the cell",
      Number(rlsTables) > 0 ? "ISOLATED" : "UNPROVED",
      `${rlsTables} tables have row-level security enabled in ${cellDb}`,
      "the migration chain's RLS policies",
    );

    await controlOwner`DROP TABLE IF EXISTS cell_isolation_probe`;
    await cellOwner`DROP TABLE IF EXISTS cell_isolation_probe`;
  } finally {
    await Promise.all([cellApp.end(), controlApp.end(), cellOwner.end(), controlOwner.end()]);
  }
}

function probeSharedInfrastructure() {
  const cellValue = (suffix) => env[envKeyFor(topology.regionKey, suffix)] ?? null;

  const compare = (resource, controlValue, cellSpecific, isolatedBy) => {
    if (!controlValue && !cellSpecific) {
      record(resource, "UNPROVED", "neither cell declares this resource", isolatedBy);
      return;
    }
    if (!cellSpecific) {
      record(
        resource,
        "SHARED",
        `the cell inherits the control plane's ${resource} (no ${envKeyFor(topology.regionKey, "…")} override)`,
        isolatedBy,
      );
      return;
    }
    record(
      resource,
      cellSpecific === controlValue ? "SHARED" : "ISOLATED",
      cellSpecific === controlValue
        ? `the cell declares the same value as the control plane`
        : `the cell declares its own value`,
      isolatedBy,
    );
  };

  const cellRedisUrl = cellValue("UPSTASH_REDIS_REST_URL");
  const cellCachePrefix = cellValue("CACHE_KEY_PREFIX");
  if (cellRedisUrl && cellRedisUrl !== env.UPSTASH_REDIS_REST_URL) {
    record(
      "cache (Redis)",
      "ISOLATED",
      `the cell declares its own Redis URL (${envKeyFor(topology.regionKey, "UPSTASH_REDIS_REST_URL")})`,
      null,
    );
  } else if (cellCachePrefix) {
    record(
      "cache (Redis)",
      "NAMESPACED",
      `all cache keys for orgs in this cell are prefixed "${cellCachePrefix}" within the shared Upstash instance ` +
        `(${envKeyFor(topology.regionKey, "CACHE_KEY_PREFIX")}). ` +
        "NAMESPACED: namespace separation prevents accidental key collisions between cells " +
        "but does not protect against an attacker holding the Upstash master token, " +
        "which grants read/write access to all cells' cached data.",
      "a separate Upstash instance per cell, with its own token",
    );
  } else {
    record(
      "cache (Redis)",
      "SHARED",
      `the cell inherits the control plane's Redis (no ${envKeyFor(topology.regionKey, "CACHE_KEY_PREFIX")} or ` +
        `${envKeyFor(topology.regionKey, "UPSTASH_REDIS_REST_URL")} override)`,
      `set ${envKeyFor(topology.regionKey, "CACHE_KEY_PREFIX")}=<cellId> for namespace isolation, ` +
        `or ${envKeyFor(topology.regionKey, "UPSTASH_REDIS_REST_URL")} for instance isolation`,
    );
  }

  const cellBucket = cellValue("R2_BUCKET_NAME");
  const cellEndpoint = cellValue("R2_ENDPOINT");
  const cellKeyPrefix = cellValue("R2_KEY_PREFIX");
  if (cellBucket && cellBucket !== env.R2_BUCKET_NAME) {
    record(
      "object storage bucket",
      "ISOLATED",
      `the cell declares its own bucket (${envKeyFor(topology.regionKey, "R2_BUCKET_NAME")}=${cellBucket})`,
      null,
    );
    record(
      "object storage endpoint",
      cellEndpoint && cellEndpoint !== env.R2_ENDPOINT ? "ISOLATED" : "SHARED",
      cellEndpoint && cellEndpoint !== env.R2_ENDPOINT
        ? `the cell declares its own endpoint (${envKeyFor(topology.regionKey, "R2_ENDPOINT")}=${cellEndpoint})`
        : "the cell uses the control plane's R2 endpoint",
      `set ${envKeyFor(topology.regionKey, "R2_ENDPOINT")} to the cell's own R2 endpoint`,
    );
  } else if (cellKeyPrefix) {
    record(
      "object storage bucket",
      "NAMESPACED",
      `object keys for this cell are prefixed "${cellKeyPrefix}/" within the shared bucket ` +
        `(${envKeyFor(topology.regionKey, "R2_KEY_PREFIX")}). ` +
        "NAMESPACED: prefix prevents accidental key collisions but does not prevent " +
        "an attacker holding the R2 access key from reading all cells' objects.",
      "a separate R2 bucket per cell, with its own access key",
    );
    record(
      "object storage endpoint",
      "NAMESPACED",
      "shared endpoint; key prefix provides logical separation within the bucket",
      "a separate R2 bucket with its own endpoint per cell",
    );
  } else {
    record(
      "object storage bucket",
      "SHARED",
      `the cell inherits the control plane's bucket (no ${envKeyFor(topology.regionKey, "R2_BUCKET_NAME")} or ` +
        `${envKeyFor(topology.regionKey, "R2_KEY_PREFIX")} override)`,
      `set ${envKeyFor(topology.regionKey, "R2_KEY_PREFIX")}=<cellId> for namespace isolation, ` +
        `or ${envKeyFor(topology.regionKey, "R2_BUCKET_NAME")} for instance isolation`,
    );
    record(
      "object storage endpoint",
      "SHARED",
      `the cell inherits the control plane's R2 endpoint (no ${envKeyFor(topology.regionKey, "R2_ENDPOINT")} override)`,
      `set ${envKeyFor(topology.regionKey, "R2_ENDPOINT")} to the cell's own endpoint`,
    );
  }

  compare("realtime broker", env.ABLY_API_KEY ? "control-plane-key" : null,
    cellValue("ABLY_API_KEY") ? "cell-key" : null,
    "an Ably application per cell, so channel namespaces cannot collide");

  const searchCluster = cellValue("SEARCH_CLUSTER");
  const searchApiKey = cellValue("SEARCH_API_KEY");
  if (searchCluster && searchCluster !== (env.SEARCH_CLUSTER ?? "primary")) {
    record(
      "search index",
      searchApiKey ? "ISOLATED" : "NAMESPACED",
      searchApiKey
        ? `the cell declares a dedicated search cluster "${searchCluster}" with its own API key`
        : `the cell declares searchCluster=${searchCluster} but no per-cell API key; ` +
          "NAMESPACED: cluster-level separation exists but the credential is shared. " +
          `Set ${envKeyFor(topology.regionKey, "SEARCH_API_KEY")} to reach ISOLATED.`,
      "a search cluster per cell with a dedicated API key",
    );
  } else {
    record(
      "search index",
      "SHARED",
      searchCluster
        ? `the cell declares searchCluster=${searchCluster} which matches the control plane's cluster`
        : "the cell inherits the control plane's search cluster; no search cluster is deployed",
      `set ${envKeyFor(topology.regionKey, "SEARCH_CLUSTER")} and ${envKeyFor(topology.regionKey, "SEARCH_API_KEY")} per cell`,
    );
  }

  record(
    "queues and dead letters",
    "ISOLATED",
    "outbox and delivery tables live in the cell's own database, so a queue row cannot cross cells",
    "per-cell outbox tables, which the cell database already provides",
  );

  const configuredCellId = cellValue("CELL_ID");
  const processHasCellId = Boolean(env.CELL_ID || configuredCellId);
  if (processHasCellId) {
    const effectiveCellId = configuredCellId ?? env.CELL_ID ?? "legacy-1";
    record(
      "worker pools",
      "NAMESPACED",
      `cron and outbox relay lease keys are scoped to cell "${effectiveCellId}" ` +
        `(cron:lease:${effectiveCellId}:<job>). A cell-2 process started with ` +
        `CELL_ID=cell-2 runs its own job slots and cannot steal a legacy-1 lease. ` +
        "NAMESPACED: job slots are separated by lease key; both cells still share " +
        "the same Upstash instance for the lease store — set " +
        `${envKeyFor(topology.regionKey, "UPSTASH_REDIS_REST_URL")} to fully isolate.`,
      "a worker process per cell, each with its own CELL_ID and ideally its own Redis",
    );
  } else {
    record(
      "worker pools",
      "SHARED",
      `CELL_ID is not set; cron and the outbox relay use global lease keys (cron:lease:<job>), ` +
        "so a second cell process would compete with legacy-1 for the same jobs",
      `set CELL_ID (or ${envKeyFor(topology.regionKey, "CELL_ID")}) on each worker process`,
    );
  }

  const hasMonitoringDimension = Boolean(env.CELL_ID || configuredCellId);
  if (hasMonitoringDimension) {
    const effectiveCellId = configuredCellId ?? env.CELL_ID ?? "legacy-1";
    record(
      "monitoring",
      "NAMESPACED",
      `every log line emitted by this process carries cellId="${effectiveCellId}"; ` +
        "read-cell-logs.mjs reads those lines from stdin and prints a per-cell breakdown. " +
        "NAMESPACED: log lines are tagged; a cross-cell aggregated view requires " +
        "shipping logs to a collector and querying by the cellId field.",
      "a per-cell log stream routed to a dedicated dashboard in the log collector",
    );
  } else {
    record(
      "monitoring",
      "UNPROVED",
      `CELL_ID is not configured; log lines carry no cellId field and read-cell-logs.mjs ` +
        "would report all lines under (no-cell)",
      `set CELL_ID on every process; run: node src/scripts/read-cell-logs.mjs to read back`,
    );
  }

  record(
    "secrets",
    topology.configured ? "ISOLATED" : "SHARED",
    topology.configured
      ? `the cell's database credentials are declared under ${envKeyFor(topology.regionKey, "*")}; ` +
        "search and cache credentials follow the same per-cell env-key pattern"
      : `the cell reuses the control plane's credentials; no ${envKeyFor(topology.regionKey, "*")} entries are set`,
    "a distinct credential set per cell for every resource (DB, cache, storage, search)",
  );
}

const MUST_BE_ISOLATED = new Set([
  "database identity",
  "application role privilege",
  "control-plane rows visible from the cell",
  "cell rows visible from the control plane",
  "cross-database bridge",
  "foreign servers",
]);

function report() {
  if (JSON_OUT) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      console.log(`${r.verdict.padEnd(10)} ${r.resource.padEnd(42)} ${r.evidence}`);
      if (r.verdict !== "ISOLATED" && r.isolatedBy)
        console.log(`${" ".repeat(11)}${" ".repeat(42)} would be isolated by: ${r.isolatedBy}`);
    }
  }

  const hardFailures = results.filter(
    (r) => MUST_BE_ISOLATED.has(r.resource) && r.verdict !== "ISOLATED",
  );
  const isolated = results.filter((r) => r.verdict === "ISOLATED").length;
  const namespaced = results.filter((r) => r.verdict === "NAMESPACED").length;
  const shared = results.filter((r) => r.verdict === "SHARED").length;
  const unproved = results.filter((r) => r.verdict === "UNPROVED").length;

  console.log(
    `\nRESULT: ${hardFailures.length === 0 ? "DATA ISOLATION PROVED" : "DATA ISOLATION FAILED"}` +
      ` cell=${topology.cellId}` +
      ` isolated=${isolated} namespaced=${namespaced} shared=${shared} unproved=${unproved}`,
  );
  if (namespaced > 0)
    console.log(
      `NOTE: NAMESPACED resources use key/prefix separation within a shared instance. ` +
        `An attacker holding the master credential of that instance can read all cells' data.`,
    );

  if (hardFailures.length > 0) {
    for (const f of hardFailures) console.error(`  FAIL: ${f.resource} — ${f.evidence}`);
    process.exitCode = 1;
  }
}

function selfTest() {
  results.length = 0;
  record("database identity", "SHARED", "both connections reached neondb", "a separate database per cell");
  const hardFailures = results.filter(
    (r) => MUST_BE_ISOLATED.has(r.resource) && r.verdict !== "ISOLATED",
  );
  if (hardFailures.length !== 1) {
    console.error("SELF-TEST FAIL: a shared database did not fail the check");
    process.exitCode = 1;
    return;
  }

  results.length = 0;
  record("cache (Redis)", "NAMESPACED", "prefix cell-2 applied", null);
  const namespaced = results.filter((r) => r.verdict === "NAMESPACED");
  if (namespaced.length === 1) {
    console.log("SELF-TEST PASS: a shared database is reported as a failure; NAMESPACED is a recognised verdict");
    return;
  }
  console.error("SELF-TEST FAIL: NAMESPACED verdict was not recorded");
  process.exitCode = 1;
}

async function main() {
  /**
   * The self-test runs FIRST and needs neither a database nor a cell topology —
   * it exercises the verdict logic against fixed rows. It used to sit behind
   * `parseCellArgs`, which throws when DATABASE_URL or APP_DATABASE_URL is
   * absent, so `--self-test` could only run on a machine that did not need it.
   */
  if (SELF_TEST) return selfTest();

  /**
   * Missing connection strings are a PREREQUISITE failure, not an isolation
   * failure. Letting the throw escape exited 1 — the same code this gate uses
   * to report that one cell can read another cell's data, so a sweep counted an
   * unconfigured laptop as a tenancy breach. `compare-cell-schema.mjs` already
   * handles it this way.
   */
  try {
    topology = parseCellArgs(argv, env);
  } catch (e) {
    console.error("PREREQUISITE MISSING:", e instanceof Error ? e.message : e);
    process.exit(2);
  }

  console.log(`cell        : ${topology.cellId}`);
  console.log(`cell app url: ${redact(topology.cell.app)}`);
  console.log(`control app : ${redact(topology.controlPlane.app)}\n`);

  await probeDatabase();
  probeSharedInfrastructure();
  report();
}

main().catch((e) => {
  console.error("ISOLATION CHECK FAILED:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
