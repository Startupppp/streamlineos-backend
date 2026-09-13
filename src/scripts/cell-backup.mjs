import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, resolve } from "node:path";
import postgres from "postgres";
import { loadEnv, parseCellArgs, redact } from "./cell-topology.mjs";
import { requireSafeTarget, topologicalOrder } from "./cell-backup-utils.mjs";

const argv = process.argv.slice(2);
const SELF_TEST = argv.includes("--self-test");

if (argv.includes("--help") || argv.length === 0) {
  console.log(`
Back up a cell, restore it, and verify the restore by reading the data back.

  node src/scripts/cell-backup.mjs --region=cell-2 --backup  [--out=backups/cell-2.ndjson]
  node src/scripts/cell-backup.mjs --region=cell-2 --restore [--in=backups/cell-2.ndjson]
  node src/scripts/cell-backup.mjs --region=cell-2 --verify  [--in=backups/cell-2.ndjson]
  node src/scripts/cell-backup.mjs --self-test

--verify recomputes every digest inside the database and compares it with the one
recorded at backup time. A restore that reports success but reads back different
rows fails here.
`);
  process.exit(0);
}

const env = SELF_TEST ? {} : loadEnv();
const topology = SELF_TEST ? null : parseCellArgs(argv, env);


const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const DEFAULT_FILE = SELF_TEST ? null : `backups/${topology.cellId}.ndjson`;
const file = SELF_TEST ? null : resolve(process.cwd(), flag("out", flag("in", DEFAULT_FILE)));

const started = Date.now();
const log = (msg) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${msg}`);

function connect(url) {
  return postgres(url, { max: 1, prepare: false, onnotice: () => {} });
}

const qualify = (schema, table) => `"${schema}"."${table}"`;

const digestSql = (schema, table) =>
  `SELECT count(*)::int AS rows,
          coalesce(md5(string_agg(d, '' ORDER BY d)), 'empty') AS digest
   FROM (SELECT md5(x::text) AS d FROM ${qualify(schema, table)} x) s`;

async function populatedTables(sql) {
  const rows = await sql`
    SELECT schemaname, tablename FROM pg_tables
    WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'drizzle')
    ORDER BY schemaname, tablename`;

  const populated = [];
  for (const { schemaname, tablename } of rows) {
    const [probe] = await sql.unsafe(
      `SELECT EXISTS (SELECT 1 FROM ${qualify(schemaname, tablename)} LIMIT 1) AS present`,
    );
    if (probe.present) populated.push({ schema: schemaname, table: tablename });
  }
  return populated;
}

async function foreignKeyEdges(sql) {
  return sql`
    SELECT cn.nspname AS child_schema, c.relname AS child,
           pn.nspname AS parent_schema, p.relname AS parent,
           k.condeferrable AS deferrable
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace cn ON cn.oid = c.relnamespace
    JOIN pg_class p ON p.oid = k.confrelid
    JOIN pg_namespace pn ON pn.oid = p.relnamespace
    WHERE k.contype = 'f'`;
}


async function backup() {
  const sql = connect(topology.cell.ownerDirect);
  try {
    const tables = await populatedTables(sql);
    const edges = await foreignKeyEdges(sql);
    const { ordered, cyclic } = topologicalOrder(tables, edges);
    const plan = [...ordered, ...cyclic];

    const lines = [];
    let totalRows = 0;

    for (const t of plan) {
      const [meta] = await sql.unsafe(digestSql(t.schema, t.table));
      const payload = await copyOut(sql, t);
      totalRows += Number(meta.rows);
      lines.push(
        JSON.stringify({
          kind: "table",
          schema: t.schema,
          table: t.table,
          rows: Number(meta.rows),
          digest: meta.digest,
          deferred: cyclic.some((c) => c.schema === t.schema && c.table === t.table),
          copy: payload.toString("base64"),
        }),
      );
      log(`${t.schema}.${t.table}: ${meta.rows} rows, digest ${meta.digest.slice(0, 12)}`);
    }

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, lines.join("\n") + "\n", "utf8");

    console.log(
      `\nRESULT: BACKUP OK cell=${topology.cellId} tables=${plan.length} rows=${totalRows}` +
        `${cyclic.length > 0 ? ` cyclic=${cyclic.length}` : ""} file=${file}`,
    );
  } finally {
    await sql.end();
  }
}

async function copyOut(sql, t) {
  const chunks = [];
  const query = sql.unsafe(`COPY ${qualify(t.schema, t.table)} TO STDOUT`);
  const readable = await query.readable();
  for await (const chunk of readable) chunks.push(chunk);
  await query;
  return Buffer.concat(chunks);
}

// pipeline() is the only form that both finalises the copy and leaves the connection usable.
// Awaiting the query after writable.end(payload) resolves BEFORE the copy completes: the next
// statement fails with COPY_IN_PROGRESS, and nothing was written.
async function copyIn(sql, t, payload) {
  const query = sql.unsafe(`COPY ${qualify(t.schema, t.table)} FROM STDIN`);
  const writable = await query.writable();
  await pipeline(Readable.from([payload]), writable);
  await query;
}

function readBackup() {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.kind === "table");
}

async function cycleBreakers(sql, cyclic) {
  if (cyclic.length === 0) return [];
  const names = cyclic.map((t) => t.table);
  return sql`
    SELECT cn.nspname AS schema, c.relname AS "table", k.conname AS name,
           pg_get_constraintdef(k.oid) AS def
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace cn ON cn.oid = c.relnamespace
    JOIN pg_class p ON p.oid = k.confrelid
    WHERE k.contype = 'f'
      AND c.relname = ANY(${names})
      AND p.relname = ANY(${names})`;
}

async function restore() {
  const tables = readBackup();
  const sql = connect(topology.cell.ownerDirect);
  try {
    const cyclic = tables.filter((t) => t.deferred);
    const breakers = await cycleBreakers(sql, cyclic);

    for (const b of breakers) {
      await sql.unsafe(
        `ALTER TABLE ${qualify(b.schema, b.table)} DROP CONSTRAINT "${b.name}"`,
      );
      log(`dropped cycle-breaking constraint ${b.table}.${b.name}`);
    }

    for (const t of [...tables].reverse())
      await sql.unsafe(`TRUNCATE ${qualify(t.schema, t.table)} CASCADE`);
    log(`truncated ${tables.length} tables`);

    let restored = 0;
    for (const t of tables) {
      if (t.rows === 0) continue;
      await copyIn(sql, t, Buffer.from(t.copy, "base64"));
      restored += t.rows;
      log(`${t.schema}.${t.table}: restored ${t.rows}`);
    }

    const unrestored = [];
    for (const b of breakers) {
      try {
        await sql.unsafe(
          `ALTER TABLE ${qualify(b.schema, b.table)} ADD CONSTRAINT "${b.name}" ${b.def}`,
        );
        log(`re-added ${b.table}.${b.name}`);
      } catch (error) {
        unrestored.push(`${b.table}.${b.name}: ${error instanceof Error ? error.message : error}`);
      }
    }

    if (unrestored.length > 0) {
      console.error(
        `\nRESULT: RESTORE INCOMPLETE — ${unrestored.length} constraint(s) could not be re-added`,
      );
      for (const u of unrestored) console.error(`  ${u}`);
      process.exitCode = 1;
      return;
    }

    console.log(
      `\nRESULT: RESTORE OK cell=${topology.cellId} rows=${restored}` +
        ` constraints_rebuilt=${breakers.length}`,
    );
  } finally {
    await sql.end();
  }
}

async function verify() {
  const tables = readBackup();
  const sql = connect(topology.cell.ownerDirect);
  const mismatches = [];
  try {
    for (const t of tables) {
      const [live] = await sql.unsafe(digestSql(t.schema, t.table));
      const ok = Number(live.rows) === t.rows && live.digest === t.digest;
      console.log(
        `${ok ? "PASS" : "FAIL"}  ${t.schema}.${t.table}` +
          ` rows ${live.rows}/${t.rows} digest ${live.digest.slice(0, 12)}/${t.digest.slice(0, 12)}`,
      );
      if (!ok)
        mismatches.push(
          `${t.schema}.${t.table}: rows ${live.rows} vs ${t.rows}, digest ${live.digest} vs ${t.digest}`,
        );
    }
  } finally {
    await sql.end();
  }

  if (mismatches.length > 0) {
    console.error(`\nRESULT: RESTORE NOT VERIFIED — ${mismatches.length} mismatch(es)`);
    for (const m of mismatches) console.error(`  ${m}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `\nRESULT: RESTORE VERIFIED BY READING cell=${topology.cellId} tables=${tables.length}`,
  );
}

function selfTest() {
  const tables = [
    { schema: "public", table: "child" },
    { schema: "public", table: "parent" },
    { schema: "public", table: "loop_a" },
    { schema: "public", table: "loop_b" },
  ];
  const edges = [
    { child_schema: "public", child: "child", parent_schema: "public", parent: "parent" },
    { child_schema: "public", child: "loop_a", parent_schema: "public", parent: "loop_b" },
    { child_schema: "public", child: "loop_b", parent_schema: "public", parent: "loop_a" },
  ];
  const { ordered, cyclic } = topologicalOrder(tables, edges);
  const names = ordered.map((t) => t.table);

  const parentFirst = names.indexOf("parent") < names.indexOf("child");
  const cycleDetected = cyclic.length === 2;

  console.log(`order: ${names.join(" -> ")}`);
  console.log(`cyclic: ${cyclic.map((t) => t.table).join(", ") || "(none)"}`);

  if (parentFirst && cycleDetected) {
    console.log("SELF-TEST PASS: parents precede children and the cycle is reported, not silently ordered");
    return;
  }
  console.error("SELF-TEST FAIL: dependency ordering is wrong");
  process.exitCode = 1;
}

async function main() {
  if (SELF_TEST) return selfTest();

  requireSafeTarget(topology);

  console.log(`cell    : ${topology.cellId}`);
  console.log(`database: ${redact(topology.cell.ownerDirect)}`);
  console.log(`file    : ${file}\n`);

  if (argv.includes("--backup")) return backup();
  if (argv.includes("--restore")) return restore();
  if (argv.includes("--verify")) return verify();

  console.error("Pick one of --backup, --restore, --verify, --self-test.");
  process.exitCode = 1;
}

main().catch((e) => {
  console.error("CELL BACKUP FAILED:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
