/**
 * bootstrap-interrupt-resume.mjs
 *
 * PRD-C055 evidence: a bootstrap that is KILLED partway and then RESUMED must reach
 * the same catalog as an uninterrupted one. That is the only run shape that exposes a
 * migration which is not idempotent, or a ledger row that commits before its own DDL.
 *
 * The interruption is real, not simulated: `db-bootstrap.mjs` is spawned as a child,
 * its stdout is followed line by line, and SIGKILL is sent the instant the requested
 * number of migrations has been acknowledged. SIGKILL is deliberate — SIGTERM would
 * let the process unwind and prove nothing about a hard crash.
 *
 * At every kill point three things are measured directly from pg_catalog, never from
 * an exit code:
 *   1. ledger rows == migrations the child reported OK/SKIP  (the atomicity invariant:
 *      a ledger row written outside its own DDL transaction shows up here as a surplus)
 *   2. no server backend is still attached to the database
 *   3. the migration that was IN FLIGHT left none of the objects it declares
 *      (tables it creates, columns it adds) behind
 *
 * Connection strings are never printed; the target is identified by host/port/database.
 *
 * Usage:
 *   node src/scripts/bootstrap-interrupt-resume.mjs \
 *     --url=<url to a scratch database> [--kill-at=150,400,600] [--json=<path>]
 *   node src/scripts/bootstrap-interrupt-resume.mjs --self-test
 *
 * Exit codes:
 *   0  reached head after every interruption, all invariants held
 *   1  an invariant failed, or the chain did not reach head
 *   2  bad arguments / refused target
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

/**
 * The URL carries a password in every deployed shape, so identity is a label, never
 * the string itself.
 */
export function safeLabel(url) {
  try {
    const u = new URL(url);
    const database = u.pathname.replace(/^\//, "").split("?")[0] || "?";
    return `${u.hostname || "?"}:${u.port || "5432"}/${database}`;
  } catch {
    return "<unparseable url>";
  }
}

/** This script drops nothing, but it does write DDL, so it stays on scratch targets. */
export function isScratchTarget(url) {
  try {
    const database = new URL(url).pathname.replace(/^\//, "").split("?")[0];
    return database.includes("scratch");
  } catch {
    return false;
  }
}

/**
 * Objects a migration file promises to create. Used to prove an interrupted migration
 * left nothing behind. Deliberately conservative: only unconditional CREATE TABLE and
 * ALTER TABLE ... ADD COLUMN, both of which are unambiguous in this chain. An
 * `IF NOT EXISTS` form is still counted — the point is whether the object appeared.
 */
export function declaredObjects(sqlText) {
  const stripped = sqlText.replace(/--[^\n]*/g, "");
  const tables = [];
  const columns = [];
  const unquote = (s) => s.replace(/"/g, "").trim();

  const createRe =
    /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:"[^"]+"|[A-Za-z0-9_]+)(?:\.(?:"[^"]+"|[A-Za-z0-9_]+))?)/gi;
  for (const m of stripped.matchAll(createRe)) tables.push(unquote(m[1]));

  const alterRe =
    /\bALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?((?:"[^"]+"|[A-Za-z0-9_]+)(?:\.(?:"[^"]+"|[A-Za-z0-9_]+))?)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|[A-Za-z0-9_]+)/gi;
  for (const m of stripped.matchAll(alterRe))
    columns.push({ table: unquote(m[1]), column: unquote(m[2]) });

  return { tables, columns };
}

/** Parse the child's stdout into the counts db-bootstrap.mjs reports. */
export function tallyLines(lines) {
  let ok = 0;
  let skip = 0;
  let fail = 0;
  let last = null;
  for (const line of lines) {
    if (line.startsWith("OK    [")) {
      ok++;
      last = line;
    } else if (line.startsWith("SKIP  [")) {
      skip++;
      last = line;
    } else if (line.startsWith("FAIL  [")) {
      fail++;
      last = line;
    }
  }
  return { ok, skip, fail, acknowledged: ok + skip, last };
}

async function catalogProbe(url, inFlightTag, journal) {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const [{ n: ledger }] = await sql`
      SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
    const [{ n: tables }] = await sql`
      SELECT count(*)::int AS n FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'drizzle')`;
    const [{ n: backends }] = await sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()`;

    const leftovers = [];
    if (inFlightTag) {
      const file = resolve(REPO, "migrations", `${inFlightTag}.sql`);
      const { tables: declTables, columns: declColumns } = declaredObjects(
        readFileSync(file, "utf8"),
      );
      for (const t of new Set(declTables)) {
        const bare = t.includes(".") ? t.split(".").pop() : t;
        const rows = await sql`
          SELECT 1 FROM pg_tables WHERE tablename = ${bare}
          AND schemaname NOT IN ('pg_catalog', 'information_schema')`;
        if (rows.length > 0) leftovers.push(`table ${t}`);
      }
      for (const c of declColumns) {
        const bare = c.table.includes(".") ? c.table.split(".").pop() : c.table;
        const rows = await sql`
          SELECT 1 FROM information_schema.columns
          WHERE table_name = ${bare} AND column_name = ${c.column}
          AND table_schema NOT IN ('pg_catalog', 'information_schema')`;
        if (rows.length > 0) leftovers.push(`column ${c.table}.${c.column}`);
      }
    }
    return { ledger, tables, backends, leftovers, journalTotal: journal.entries.length };
  } finally {
    await sql.end();
  }
}

function runBootstrap(url, killAfter, onLine) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ["src/scripts/db-bootstrap.mjs"], {
      cwd: REPO,
      env: {
        ...process.env,
        DATABASE_URL: url,
        DIRECT_DATABASE_URL: url,
        PGSSLMODE: "disable",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const lines = [];
    let killed = false;
    let acknowledged = 0;
    let buffer = "";

    const consume = (chunk) => {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        lines.push(line);
        if (onLine) onLine(line);
        if (line.startsWith("OK    [") || line.startsWith("SKIP  [")) acknowledged++;
        if (!killed && killAfter && acknowledged >= killAfter) {
          killed = true;
          child.kill("SIGKILL");
        }
      }
    };

    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.on("close", (code, signal) => {
      if (buffer.length > 0) lines.push(buffer);
      resolvePromise({ code, signal, lines, killed, acknowledged });
    });
  });
}

function selfTest() {
  const cases = [];
  const eq = (name, got, want) =>
    cases.push({ name, pass: JSON.stringify(got) === JSON.stringify(want), got, want });

  eq("safeLabel hides credentials", safeLabel("postgres://u:p@h:5432/scratch_x?a=b"), "h:5432/scratch_x");
  eq("safeLabel on rubbish", safeLabel("not a url"), "<unparseable url>");
  eq("scratch target accepted", isScratchTarget("postgres://h/scratch_boot_q"), true);
  eq("non-scratch target refused", isScratchTarget("postgres://h/postgres"), false);
  eq("non-scratch neon-shaped refused", isScratchTarget("postgres://u:p@ep-x.neon.tech/neondb"), false);

  const d1 = declaredObjects(`CREATE TABLE IF NOT EXISTS "org_relocations" (id uuid);`);
  eq("CREATE TABLE parsed", d1.tables, ["org_relocations"]);

  const d2 = declaredObjects(
    `ALTER TABLE "organization_relocations" ADD COLUMN "copy_started_at" timestamp;`,
  );
  eq("ADD COLUMN parsed", d2.columns, [
    { table: "organization_relocations", column: "copy_started_at" },
  ]);

  const d3 = declaredObjects(`-- CREATE TABLE "commented_out" (x int);\nSELECT 1;`);
  eq("comment ignored", d3.tables, []);

  const d4 = declaredObjects(`CREATE TABLE app.thing (x int);`);
  eq("schema-qualified table parsed", d4.tables, ["app.thing"]);

  const t = tallyLines(["OK    [a]", "SKIP  [b]", "OK    [c]", "noise"]);
  eq("tally counts", { ok: t.ok, skip: t.skip, acknowledged: t.acknowledged }, { ok: 2, skip: 1, acknowledged: 3 });
  eq("tally last", t.last, "OK    [c]");

  const failed = cases.filter((c) => !c.pass);
  for (const c of cases)
    console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass ? "" : `  got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`}`);
  console.log(`\nRESULT: ${cases.length - failed.length}/${cases.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

if (argv.includes("--self-test")) selfTest();

const url = arg("url");
if (!url) {
  console.error("bootstrap-interrupt-resume: --url=<scratch database url> is required");
  process.exit(2);
}
if (!isScratchTarget(url)) {
  console.error(
    `bootstrap-interrupt-resume: refusing to run against "${safeLabel(url)}" — the database name must contain "scratch". This script applies the whole migration chain.`,
  );
  process.exit(2);
}

const journal = JSON.parse(
  readFileSync(resolve(REPO, "migrations/meta/_journal.json"), "utf8"),
);
const killPoints = arg("kill-at", "150,400,600")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0 && n < journal.entries.length);

console.log(`target        ${safeLabel(url)}`);
console.log(`journal       ${journal.entries.length} entries, head ${journal.entries.at(-1).tag}`);
console.log(`kill points   ${killPoints.join(", ") || "(none — plain run)"}`);
console.log("");

const phases = [];
let failures = 0;

for (let i = 0; i < killPoints.length; i++) {
  const target = killPoints[i];
  const before = phases.at(-1)?.probe.ledger ?? 0;
  const killAfter = target;
  const started = Date.now();
  const run = await runBootstrap(url, killAfter);
  const elapsed = Math.round((Date.now() - started) / 1000);
  const tally = tallyLines(run.lines);

  // The entry that was in flight is the one after the last acknowledgement.
  const inFlight = journal.entries[tally.acknowledged]?.tag ?? null;
  // pg_stat_activity can lag the kill by a few ms; give the server a moment.
  await new Promise((r) => setTimeout(r, 750));
  const probe = await catalogProbe(url, inFlight, journal);

  const invariants = [
    {
      name: "process died to the signal",
      pass: run.signal === "SIGKILL" || run.killed,
      detail: `signal=${run.signal} code=${run.code} killed=${run.killed}`,
    },
    {
      name: "ledger rows == acknowledged migrations",
      pass: probe.ledger === tally.acknowledged,
      detail: `ledger=${probe.ledger} acknowledged=${tally.acknowledged} (ok=${tally.ok} skip=${tally.skip})`,
    },
    {
      name: "no backend left attached",
      pass: probe.backends === 0,
      detail: `backends=${probe.backends}`,
    },
    {
      name: "in-flight migration left nothing behind",
      pass: probe.leftovers.length === 0,
      detail: inFlight
        ? `in-flight=${inFlight} leftovers=${probe.leftovers.length}${probe.leftovers.length ? ` [${probe.leftovers.join(", ")}]` : ""}`
        : "no in-flight entry",
    },
  ];

  console.log(`--- interruption ${i + 1}: SIGKILL after ${tally.acknowledged} acknowledged (${elapsed}s) ---`);
  console.log(`    resumed-from=${before}  ok=${tally.ok}  skip=${tally.skip}  last=${tally.last ?? "-"}`);
  console.log(`    in flight   ${inFlight ?? "-"}`);
  console.log(`    tables      ${probe.tables}`);
  for (const inv of invariants) {
    if (!inv.pass) failures++;
    console.log(`    ${inv.pass ? "PASS" : "FAIL"}  ${inv.name}  —  ${inv.detail}`);
  }
  console.log("");

  phases.push({ kind: "interrupted", target, elapsed, tally, inFlight, probe, invariants });
}

{
  const started = Date.now();
  const run = await runBootstrap(url, 0);
  const elapsed = Math.round((Date.now() - started) / 1000);
  const tally = tallyLines(run.lines);
  const probe = await catalogProbe(url, null, journal);
  const reached = run.lines.some((l) => l.includes(`REACHED_HEAD ${journal.entries.length}/${journal.entries.length}`));

  const invariants = [
    { name: "resume exited 0", pass: run.code === 0, detail: `code=${run.code}` },
    {
      name: "resume reached head",
      pass: reached,
      detail: `${tally.ok} ok + ${tally.skip} skip = ${tally.acknowledged} / ${journal.entries.length}`,
    },
    {
      name: "ledger == journal",
      pass: probe.ledger === journal.entries.length,
      detail: `ledger=${probe.ledger} journal=${journal.entries.length}`,
    },
    {
      name: "resume skipped exactly what survived the last kill",
      pass: tally.skip === (phases.at(-1)?.probe.ledger ?? 0),
      detail: `skip=${tally.skip} survived=${phases.at(-1)?.probe.ledger ?? 0}`,
    },
  ];

  console.log(`--- resume (${elapsed}s) ---`);
  for (const inv of invariants) {
    if (!inv.pass) failures++;
    console.log(`    ${inv.pass ? "PASS" : "FAIL"}  ${inv.name}  —  ${inv.detail}`);
  }
  console.log(`    tables      ${probe.tables}`);
  console.log("");
  phases.push({ kind: "resume", elapsed, tally, probe, invariants });
}

{
  const run = await runBootstrap(url, 0);
  const tally = tallyLines(run.lines);
  const pass = run.code === 0 && tally.ok === 0 && tally.skip === journal.entries.length;
  if (!pass) failures++;
  console.log(`--- idempotency re-run ---`);
  console.log(
    `    ${pass ? "PASS" : "FAIL"}  re-run is a no-op  —  code=${run.code} ok=${tally.ok} skip=${tally.skip}`,
  );
  console.log("");
  phases.push({ kind: "rerun", tally, pass });
}

const jsonPath = arg("json");
if (jsonPath) {
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        target: safeLabel(url),
        journalEntries: journal.entries.length,
        journalHead: journal.entries.at(-1).tag,
        killPoints,
        phases: phases.map((p) => ({
          kind: p.kind,
          target: p.target ?? null,
          inFlight: p.inFlight ?? null,
          ok: p.tally?.ok ?? null,
          skip: p.tally?.skip ?? null,
          ledger: p.probe?.ledger ?? null,
          tables: p.probe?.tables ?? null,
          invariants: p.invariants ?? null,
        })),
        failures,
      },
      null,
      2,
    ),
  );
  console.log(`json written  ${jsonPath}`);
}

console.log(
  failures === 0
    ? `RESULT: INTERRUPTED BOOTSTRAP REACHED HEAD  ${killPoints.length} interruption(s), 0 invariant failures`
    : `RESULT: FAILED  ${failures} invariant failure(s)`,
);
process.exit(failures === 0 ? 0 : 1);
