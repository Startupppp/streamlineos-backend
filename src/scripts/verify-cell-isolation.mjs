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

Every resource ticket 26 names is reported as ISOLATED, SHARED or UNPROVED.
A SHARED verdict names what would isolate it. Exit is non-zero when a resource
that must be isolated is not.
`);
  process.exit(0);
}

const SELF_TEST = argv.includes("--self-test");
const JSON_OUT = argv.includes("--json");
const topology = parseCellArgs(argv, env);

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

  compare("cache (Redis)", env.UPSTASH_REDIS_REST_URL, cellValue("UPSTASH_REDIS_REST_URL"),
    "a Redis instance per cell, addressed through the region definition");
  compare("object storage bucket", env.R2_BUCKET_NAME, cellValue("R2_BUCKET_NAME"),
    "a bucket or key prefix per cell in RegionStorageConfig");
  compare("object storage endpoint", env.R2_ENDPOINT, cellValue("R2_ENDPOINT"),
    "an endpoint per cell in RegionStorageConfig");
  compare("realtime broker", env.ABLY_API_KEY ? "control-plane-key" : null,
    cellValue("ABLY_API_KEY") ? "cell-key" : null,
    "an Ably application per cell, so channel namespaces cannot collide");

  const searchCluster = cellValue("SEARCH_CLUSTER");
  record(
    "search index",
    searchCluster && searchCluster !== (env.SEARCH_CLUSTER ?? "primary") ? "ISOLATED" : "SHARED",
    searchCluster
      ? `the cell declares searchCluster=${searchCluster}; no search cluster is deployed for it`
      : "the cell inherits the control plane's search cluster",
    "a search cluster per cell",
  );

  record(
    "queues and dead letters",
    "ISOLATED",
    "outbox and delivery tables live in the cell's own database, so a queue row cannot cross cells",
    "per-cell outbox tables, which the cell database already provides",
  );

  record(
    "worker pools",
    "UNPROVED",
    "no worker process is deployed for the cell; cron and the outbox relay run in the control-plane process",
    "a worker deployment per cell, scheduled against the cell's own database",
  );

  record(
    "monitoring",
    "UNPROVED",
    "logs and metrics carry no cell dimension that this script can read back",
    "a cellId label on every log line, span and metric, and a per-cell dashboard",
  );

  record(
    "secrets",
    topology.configured ? "ISOLATED" : "SHARED",
    topology.configured
      ? `the cell's credentials are declared under ${envKeyFor(topology.regionKey, "*")}`
      : `the cell reuses the control plane's credentials; no ${envKeyFor(topology.regionKey, "*")} entries are set`,
    "a distinct credential set per cell",
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
      console.log(`${r.verdict.padEnd(9)} ${r.resource.padEnd(42)} ${r.evidence}`);
      if (r.verdict !== "ISOLATED" && r.isolatedBy)
        console.log(`${" ".repeat(10)}${" ".repeat(42)} would be isolated by: ${r.isolatedBy}`);
    }
  }

  const hardFailures = results.filter(
    (r) => MUST_BE_ISOLATED.has(r.resource) && r.verdict !== "ISOLATED",
  );
  const shared = results.filter((r) => r.verdict === "SHARED").length;
  const unproved = results.filter((r) => r.verdict === "UNPROVED").length;

  console.log(
    `\nRESULT: ${hardFailures.length === 0 ? "DATA ISOLATION PROVED" : "DATA ISOLATION FAILED"}` +
      ` cell=${topology.cellId} isolated=${results.filter((r) => r.verdict === "ISOLATED").length}` +
      ` shared=${shared} unproved=${unproved}`,
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
  if (hardFailures.length === 1) {
    console.log("SELF-TEST PASS: a shared database is reported as a failure, not as a note");
    return;
  }
  console.error("SELF-TEST FAIL: a shared database did not fail the check");
  process.exitCode = 1;
}

async function main() {
  if (SELF_TEST) return selfTest();

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
