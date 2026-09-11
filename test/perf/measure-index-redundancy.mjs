#!/usr/bin/env node
/**
 * Verifies an index-redundancy verdict with EXPLAIN (ANALYZE, BUFFERS) instead of structure alone.
 *
 * Structural containment (an exact duplicate, or a strict leading prefix of a wider btree) proves a
 * surviving index CAN answer every predicate the dropped one answered. It does not prove the planner
 * WILL choose it, nor that it costs the same, and on a single-tenant database it cannot: with one
 * distinct org_id the tenant column discriminates nothing, so an org-leading index looks strictly
 * worse than a narrower one and reads as redundant. The same query on this seed picks different
 * indexes for different tenants — 6 buffers for a 0.18% tenant against 1,237 for the 89.9% tenant.
 *
 * So every candidate is measured against EVERY tenant across the skew, as the non-owner application
 * role with the tenant GUC set, in a transaction that is rolled back. The dropped index is recreated
 * inside that transaction and the same queries are run again, so the comparison is same-session,
 * same-cache, same-statistics.
 *
 * Usage:
 *   OWNER_DATABASE_URL=<neondb_owner url on a scratch database> \
 *     node test/perf/measure-index-redundancy.mjs [--drops=<json>] [--out=<dir>] [--only=<idx,idx>]
 *
 * The owner URL is needed because recreating an index is DDL. Every measurement itself runs after
 * SET LOCAL ROLE to the application role, which carries neither SUPERUSER nor BYPASSRLS, so the
 * plans include the RLS predicate. The script refuses to start unless that is true.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { assertScratchTarget } from "./heavy-query-fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROLE = "streamline_app";

export const TENANTS = [
  { label: "large", id: "aaaaaaaa-1111-0000-0000-000000000001", share: "89.93%" },
  { label: "mid", id: "aaaaaaaa-1111-0000-0000-000000000003", share: "9.0%" },
  { label: "small", id: "aaaaaaaa-1111-0000-0000-000000000002", share: "0.90%" },
  { label: "tiny", id: "aaaaaaaa-1111-0000-0000-000000000004", share: "0.18%" },
];

const IDENT = /^[a-z_][a-z0-9_$]*$/;

export function parseIndexDef(def) {
  const head = /^CREATE\s+(UNIQUE\s+)?INDEX\s+(\S+)\s+ON\s+([\w".]+)\s+USING\s+(\w+)\s+\(/i.exec(def);
  if (!head) return null;
  const open = def.indexOf("(", head[0].length - 1);
  let depth = 0;
  let close = -1;
  for (let i = open; i < def.length; i++) {
    if (def[i] === "(") depth++;
    else if (def[i] === ")") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return null;
  const cols = splitTop(def.slice(open + 1, close)).map((raw) => {
    const desc = /\bDESC\b/i.test(raw);
    const name = raw.replace(/\s+(ASC|DESC)\b/i, "").replace(/\s+NULLS\s+(FIRST|LAST)\b/i, "").trim();
    return { name, desc, plain: IDENT.test(name) };
  });
  const where = /\bWHERE\s+(.+)$/is.exec(def.slice(close));
  return {
    unique: Boolean(head[1]),
    name: head[2],
    table: head[3],
    am: head[4].toLowerCase(),
    cols,
    predicate: where ? where[1].trim() : null,
  };
}

export function splitTop(body) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

export function sumBuffers(node, acc = { hit: 0, read: 0, rows: 0 }) {
  if (!node || typeof node !== "object") return acc;
  acc.hit += node["Shared Hit Blocks"] ?? 0;
  acc.read += node["Shared Read Blocks"] ?? 0;
  const loops = node["Actual Loops"] ?? 1;
  acc.rows += (node["Actual Rows"] ?? 0) * (node["Node Type"] === "Nested Loop" ? 1 : loops === 1 ? 1 : 1);
  for (const child of node.Plans ?? []) sumBuffers(child, acc);
  return acc;
}

export function indexesUsed(node, out = new Set()) {
  if (!node || typeof node !== "object") return out;
  if (node["Index Name"]) out.add(node["Index Name"]);
  for (const child of node.Plans ?? []) indexesUsed(child, out);
  return out;
}

export function selfTest() {
  const checks = [];
  const p = parseIndexDef(
    "CREATE INDEX idx_x ON public.t USING btree (org_id, created_at DESC NULLS LAST) WHERE (deleted_at IS NULL)",
  );
  checks.push(["parses name", p?.name === "idx_x"]);
  checks.push(["parses table", p?.table === "public.t"]);
  checks.push(["parses am", p?.am === "btree"]);
  checks.push(["parses 2 columns", p?.cols.length === 2]);
  checks.push(["marks DESC", p?.cols[1].desc === true]);
  checks.push(["strips NULLS LAST", p?.cols[1].name === "created_at"]);
  checks.push(["parses predicate", p?.predicate === "(deleted_at IS NULL)"]);
  const e = parseIndexDef("CREATE UNIQUE INDEX u ON public.t USING btree (lower(email))");
  checks.push(["marks expression column non-plain", e?.cols[0].plain === false]);
  checks.push(["marks unique", e?.unique === true]);
  const nested = {
    "Shared Hit Blocks": 1,
    "Shared Read Blocks": 2,
    Plans: [{ "Shared Hit Blocks": 4, "Shared Read Blocks": 8, "Index Name": "child_idx" }],
  };
  const b = sumBuffers(nested);
  checks.push(["sums buffers over the tree", b.hit === 5 && b.read === 10]);
  checks.push(["collects index names from children", indexesUsed(nested).has("child_idx")]);
  checks.push(["splitTop ignores nested commas", splitTop("a, f(b, c), d").length === 3]);
  const bad = assertScratchTarget("postgres://u@h/production", []);
  checks.push(["refuses a non-scratch database", bad.ok === false]);
  let failed = 0;
  for (const [label, ok] of checks) {
    if (!ok) failed++;
    console.log(`  ${ok ? "[pass]" : "[FAIL]"} ${label}`);
  }
  console.log(`\n${failed === 0 ? "SELF-TEST PASSED" : "SELF-TEST FAILED"} — ${checks.length - failed}/${checks.length}`);
  return failed === 0;
}

if (process.argv.includes("--self-test")) {
  process.exit(selfTest() ? 0 : 1);
}

const arg = (flag, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : fallback;
};

const url = process.env.OWNER_DATABASE_URL;
if (!url) {
  console.error("OWNER_DATABASE_URL is required (neondb_owner on a scratch database).");
  process.exit(1);
}
const guard = assertScratchTarget(url, [process.env.DATABASE_URL, process.env.APP_DATABASE_URL]);
if (!guard.ok) {
  console.error(`refusing to run: ${guard.reason}`);
  process.exit(1);
}

const dropsPath = resolve(arg("--drops", resolve(HERE, "index-redundancy-candidates.json")));
const outDir = arg("--out", resolve(HERE, "index-redundancy"));
const only = arg("--only", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const candidates = JSON.parse(readFileSync(dropsPath, "utf8")).filter(
  (c) => only.length === 0 || only.includes(c.idx),
);

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });

async function main() {
  const [role] = await sql`SELECT current_user AS who, current_database() AS db`;
  const [appRole] = await sql`
    SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${APP_ROLE}`;
  if (!appRole) throw new Error(`role ${APP_ROLE} does not exist on ${role.db}`);
  if (appRole.rolsuper || appRole.rolbypassrls)
    throw new Error(`${APP_ROLE} is superuser/bypassrls — its plans would omit the RLS predicate`);

  let rlsProven = false;
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${APP_ROLE}`);
      await tx.unsafe(`SELECT count(*) FROM calendar_events`);
    });
  } catch (err) {
    rlsProven = /42501|tenant context/i.test(String(err?.message ?? err));
  }
  if (!rlsProven) throw new Error("a no-GUC read did not fail — RLS is not live on this database");

  console.log(
    `role ${role.who} · measuring as ${APP_ROLE} (bypassrls=false) · no-GUC read denied · database ${role.db}`,
  );
  console.log(`candidates: ${candidates.length} · tenants: ${TENANTS.map((t) => t.label).join(", ")}\n`);

  const results = [];
  for (const cand of candidates) {
    const parsed = parseIndexDef(cand.def);
    if (!parsed) {
      results.push({ ...cand, status: "UNPARSED" });
      console.log(`SKIP ${cand.idx} — index definition not parseable`);
      continue;
    }
    const queries = await buildQueries(parsed, cand);
    if (queries.length === 0) {
      results.push({ ...cand, status: "NO_QUERY" });
      console.log(`SKIP ${cand.idx} — no tenant holds a sampleable row on ${parsed.table}`);
      continue;
    }
    const measured = await measure(parsed, cand, queries);
    results.push(measured);
    report(measured);
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/index-redundancy.json`, `${JSON.stringify(results, null, 1)}\n`);
  const regressions = results.filter((r) => r.verdict === "REGRESSION");
  console.log(`\n--- ${results.length} candidates · ${regressions.length} REGRESSION ---`);
  for (const r of regressions) console.log(`  REGRESSION ${r.table}.${r.idx}`);
  writeFileSync(`${outDir}/index-redundancy.txt`, `${results.map(lineFor).join("\n")}\n`);
  return regressions.length === 0 ? 0 : 2;
}

async function tenantRows(table, tenantCol, tenant) {
  const [row] = await sql.unsafe(
    `SELECT count(*)::bigint AS n FROM ${table} WHERE ${tenantCol} = $1`,
    [tenant],
  );
  return Number(row.n);
}

async function tenantColumnOf(table) {
  const [schema, name] = table.replace(/"/g, "").split(".");
  const rows = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = ${schema} AND table_name = ${name}
      AND column_name IN ('org_id', 'organization_id')`;
  return rows[0]?.column_name ?? null;
}

async function buildQueries(parsed, cand) {
  const tenantCol = await tenantColumnOf(parsed.table);
  const plain = parsed.cols.filter((c) => c.plain);
  if (plain.length === 0) return [];
  const out = [];
  for (const tenant of TENANTS) {
    const where = tenantCol ? `${tenantCol} = '${tenant.id}'` : null;
    if (tenantCol && (await tenantRows(parsed.table, tenantCol, tenant.id)) === 0) continue;
    const sampleCols = plain.map((c) => c.name).join(", ");
    const sampleWhere = [where, parsed.predicate].filter(Boolean).join(" AND ");
    const [sample] = await sql.unsafe(
      `SELECT ${sampleCols} FROM ${parsed.table}${sampleWhere ? ` WHERE ${sampleWhere}` : ""} LIMIT 1`,
    );
    if (!sample) continue;
    const eq = plain.map((c) => literalEq(c.name, sample[c.name]));
    const last = plain[plain.length - 1];
    const leading = plain.slice(0, -1).map((c) => literalEq(c.name, sample[c.name]));
    const filter = [...eq, parsed.predicate].filter(Boolean).join(" AND ");
    out.push({
      tenant,
      shape: "equality",
      sql: `SELECT count(*) FROM ${parsed.table} WHERE ${filter}`,
    });
    if (plain.length > 1) {
      const orderFilter = [...leading, parsed.predicate].filter(Boolean).join(" AND ");
      out.push({
        tenant,
        shape: "ordered-page",
        sql:
          `SELECT ${sampleCols} FROM ${parsed.table} WHERE ${orderFilter} ` +
          `ORDER BY ${last.name} ${last.desc ? "DESC" : "ASC"} LIMIT 50`,
      });
    }
  }
  if (cand.rows !== undefined && out.length === 0) return [];
  return out;
}

function literalEq(col, value) {
  if (value === null || value === undefined) return `${col} IS NULL`;
  if (typeof value === "number") return `${col} = ${value}`;
  if (typeof value === "boolean") return `${col} = ${value}`;
  if (value instanceof Date) return `${col} = '${value.toISOString()}'::timestamptz`;
  return `${col} = '${String(value).replace(/'/g, "''")}'`;
}

async function explain(tx, tenant, statement) {
  await tx.unsafe(`SELECT set_config('app.organization_id', '${tenant.id}', true)`);
  const rows = await tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`);
  const plan = rows[0]["QUERY PLAN"][0].Plan;
  const b = sumBuffers(plan);
  return { buffers: b.hit + b.read, indexes: [...indexesUsed(plan)], node: plan["Node Type"] };
}

const ROLLBACK = Symbol("rollback");

async function measure(parsed, cand, queries) {
  const rows = [];
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL statement_timeout = '120s'");
      await tx.unsafe(`SET LOCAL ROLE ${APP_ROLE}`);
      for (const q of queries) rows.push({ ...q, without: await explain(tx, q.tenant, q.sql) });
      await tx.unsafe("RESET ROLE");
      await tx.unsafe(cand.def);
      await tx.unsafe(`SET LOCAL ROLE ${APP_ROLE}`);
      for (const row of rows) row.with = await explain(tx, row.tenant, row.sql);
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }

  const measurements = rows.map((r) => ({
    tenant: r.tenant.label,
    share: r.tenant.share,
    shape: r.shape,
    sql: r.sql,
    buffersWithout: r.without.buffers,
    buffersWith: r.with.buffers,
    planWithout: `${r.without.node}${r.without.indexes.length ? ` (${r.without.indexes.join(", ")})` : ""}`,
    planWith: `${r.with.node}${r.with.indexes.length ? ` (${r.with.indexes.join(", ")})` : ""}`,
    chosen: r.with.indexes.includes(parsed.name),
  }));

  const chosen = measurements.filter((m) => m.chosen);
  const worse = chosen.filter((m) => m.buffersWith * 2 <= m.buffersWithout && m.buffersWithout - m.buffersWith >= 8);
  const verdict = worse.length > 0 ? "REGRESSION" : chosen.length > 0 ? "CHOSEN_NO_GAIN" : "CONFIRMED_REDUNDANT";
  return { ...cand, index: parsed.name, table: parsed.table, verdict, measurements };
}

function lineFor(r) {
  if (!r.measurements) return `${r.status}\t${r.table ?? ""}\t${r.idx}`;
  const worst = r.measurements.reduce(
    (a, m) => (m.buffersWithout - m.buffersWith > a.buffersWithout - a.buffersWith ? m : a),
    r.measurements[0],
  );
  return `${r.verdict}\t${r.table}\t${r.idx}\tkeep=${r.keep ?? "-"}\tworst=${worst.tenant}/${worst.shape} ${worst.buffersWithout}->${worst.buffersWith}`;
}

function report(r) {
  console.log(`${r.verdict}  ${r.table}.${r.idx}  (${r.kind ?? "?"} of ${r.keep ?? "?"})`);
  for (const m of r.measurements)
    console.log(
      `    ${m.tenant.padEnd(6)} ${m.shape.padEnd(13)} without=${String(m.buffersWithout).padStart(7)} [${m.planWithout}] ` +
        `· with=${String(m.buffersWith).padStart(7)} [${m.planWith}] ` +
        `· ${m.chosen ? "planner PICKS the dropped index" : "planner declines the dropped index"}`,
    );
}

main()
  .then(async (code) => {
    await sql.end();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err);
    await sql.end();
    process.exit(1);
  });
