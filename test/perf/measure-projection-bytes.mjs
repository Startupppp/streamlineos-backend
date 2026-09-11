#!/usr/bin/env node
/**
 * Measures what a projection actually saves: BYTES RETURNED, not buffers.
 *
 * `EXPLAIN (ANALYZE, BUFFERS)` cannot score a projection. Buffers count heap pages touched, and
 * every column of a row lives in the same heap page, so a 38-column read and an 8-column read of
 * the same rows report the identical buffer count — measured at 417 buffers / 19,587 rows for both
 * halves of `dashboard-recent-activity`. What a projection costs is bytes across the database
 * boundary and bytes resident in the Node heap, and `pg_column_size(row(...))` is the instrument
 * for that: it reports the on-the-wire size of exactly the columns named.
 *
 * Runs as the non-owner application role with the tenant GUC set, in a rolled-back transaction, so
 * the rows measured are the rows the endpoint would actually return under RLS.
 *
 * Usage:
 *   OWNER_DATABASE_URL=<neondb_owner url on a scratch database> \
 *     node test/perf/measure-projection-bytes.mjs [--org=large|mid|small|tiny] [--out=<dir>]
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { assertScratchTarget } from "./heavy-query-fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROLE = "streamline_app";

const TENANTS = {
  large: "aaaaaaaa-1111-0000-0000-000000000001",
  mid: "aaaaaaaa-1111-0000-0000-000000000003",
  small: "aaaaaaaa-1111-0000-0000-000000000002",
  tiny: "aaaaaaaa-1111-0000-0000-000000000004",
};

/**
 * `full` is the column list the read returns today with no projection — the Drizzle DECLARED set,
 * which is what a bare `.select()` or a `findMany` with no `columns:` emits. It is not `SELECT *`:
 * an undeclared column is never fetched, so the live catalog would overstate the cost.
 */
export const PATHS = [
  {
    id: "kb-pages-list-100",
    table: "kb_pages",
    where: "deleted_at IS NULL",
    limit: 100,
    note: "the getTrash/list column set. Measured over live pages because trash is empty on this seed; the trash list uses the identical columns and the UI renders only id, title, icon, deleted_at",
    full: ["id","org_id","space_id","parent_page_id","title","icon","cover_image","content","content_text","fts","sort_order","is_locked","created_by_id","created_by_membership_id","last_edited_by_id","last_edited_by_membership_id","deleted_at","deleted_by_id","deleted_by_membership_id","created_at","updated_at","acl_revision","content_revision","visibility","public_token","status","content_type","trust_state","owner_user_id","owner_membership_id","verified_by_id","verified_by_membership_id","verified_until","next_review_at","public_slug","source_article_id","project_id"],
    projected: null,
    drop: ["content", "content_text", "fts"],
  },
  {
    id: "kb-pages-update-guard",
    table: "kb_pages",
    where: "deleted_at IS NULL",
    limit: 1,
    note: "PATCH /kb/pages/:id reads the row only for is_locked, trust_state and content",
    full: null,
    inherit: "kb-pages-list-100",
    projected: ["id", "is_locked", "trust_state", "content"],
  },
  {
    id: "dashboard-recent-activity",
    table: "build.tickets",
    where: "deleted_at IS NULL",
    limit: 10,
    note: "the pair EXPLAIN(BUFFERS) reported as identical at 417 buffers",
    full: "*declared*",
    projected: ["id", "org_id", "project_id", "title", "status", "priority", "updated_at", "assignee_membership_id"],
  },
  {
    id: "attendance-list-page",
    table: "attendance",
    where: null,
    limit: 100,
    note: "attendance-read.service.ts findMany with no columns; breaks and location_data are jsonb",
    full: "*declared*",
    projected: null,
    drop: ["breaks", "location_data"],
  },
  {
    id: "kb-chunks-page-50",
    table: "kb_article_chunks",
    where: null,
    limit: 50,
    note: "no shipped read hydrates embedding — this is what one unprojected read of the vector table would cost",
    full: "*declared*",
    projected: null,
    drop: ["embedding"],
  },
  {
    id: "notifications-list-page",
    table: "notifications",
    where: null,
    limit: 20,
    note: "notification list page",
    full: "*declared*",
    projected: null,
    drop: ["metadata"],
  },
];

export function buildSql(table, cols, where, limit) {
  const rowExpr = `row(${cols.map((c) => `t."${c}"`).join(", ")})`;
  return `SELECT count(*)::bigint AS rows, COALESCE(sum(pg_column_size(${rowExpr})), 0)::bigint AS bytes
          FROM (SELECT * FROM ${table}${where ? ` WHERE ${where}` : ""} LIMIT ${limit}) t`;
}

export function selfTest() {
  const checks = [];
  const s = buildSql("kb_pages", ["id", "title"], "deleted_at IS NULL", 10);
  checks.push(["names each column explicitly", s.includes('t."id"') && s.includes('t."title"')]);
  checks.push(["wraps the limit in a subquery", /FROM \(SELECT \* FROM kb_pages WHERE deleted_at IS NULL LIMIT 10\) t/.test(s)]);
  checks.push(["measures pg_column_size of a row constructor", s.includes("pg_column_size(row(")]);
  checks.push(["omits WHERE when there is none", !buildSql("t", ["id"], null, 1).includes("WHERE")]);
  checks.push(["every path names a table", PATHS.every((p) => typeof p.table === "string" && p.table.length > 0)]);
  checks.push(["every path names either a projection or a drop list", PATHS.every((p) => p.projected || p.drop)]);
  checks.push(["path ids are unique", new Set(PATHS.map((p) => p.id)).size === PATHS.length]);
  checks.push(["refuses a non-scratch database", assertScratchTarget("postgres://u@h/prod", []).ok === false]);
  let failed = 0;
  for (const [label, ok] of checks) {
    if (!ok) failed++;
    console.log(`  ${ok ? "[pass]" : "[FAIL]"} ${label}`);
  }
  console.log(`\n${failed === 0 ? "SELF-TEST PASSED" : "SELF-TEST FAILED"} — ${checks.length - failed}/${checks.length}`);
  return failed === 0;
}

if (process.argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);

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
const orgLabel = arg("--org", "large");
const orgId = TENANTS[orgLabel];
if (!orgId) {
  console.error(`unknown --org=${orgLabel}; expected one of ${Object.keys(TENANTS).join(", ")}`);
  process.exit(1);
}
const outDir = arg("--out", resolve(HERE, "projection-bytes"));
const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });

async function declaredColumns(table) {
  const [schema, name] = table.includes(".") ? table.split(".") : ["public", table];
  const rows = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = ${schema} AND table_name = ${name}
      AND is_generated <> 'ALWAYS'
    ORDER BY ordinal_position`;
  const generated = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = ${schema} AND table_name = ${name} AND is_generated = 'ALWAYS'`;
  return [...rows.map((r) => r.column_name), ...generated.map((r) => r.column_name)];
}

const ROLLBACK = Symbol("rollback");

async function main() {
  const [app] = await sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${APP_ROLE}`;
  if (!app || app.rolsuper || app.rolbypassrls)
    throw new Error(`${APP_ROLE} must exist and carry neither SUPERUSER nor BYPASSRLS`);
  const [db] = await sql`SELECT current_database() AS db`;
  console.log(`measuring as ${APP_ROLE} (bypassrls=false) · tenant ${orgLabel} · database ${db.db}\n`);

  const resolved = new Map();
  for (const p of PATHS) {
    let full = p.full;
    if (p.inherit) full = resolved.get(p.inherit);
    else if (full === "*declared*") full = await declaredColumns(p.table);
    resolved.set(p.id, full);
  }

  const rows = [];
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${APP_ROLE}`);
      await tx.unsafe(`SELECT set_config('app.organization_id', '${orgId}', true)`);
      for (const p of PATHS) {
        const full = resolved.get(p.id);
        const projected = p.projected ?? full.filter((c) => !p.drop.includes(c));
        const missing = [...(p.projected ?? []), ...(p.drop ?? [])].filter((c) => !full.includes(c));
        const a = (await tx.unsafe(buildSql(p.table, full, p.where, p.limit)))[0];
        const b = (await tx.unsafe(buildSql(p.table, projected, p.where, p.limit)))[0];
        rows.push({
          id: p.id,
          table: p.table,
          note: p.note,
          rows: Number(a.rows),
          fullColumns: full.length,
          projectedColumns: projected.length,
          fullBytes: Number(a.bytes),
          projectedBytes: Number(b.bytes),
          saved: Number(a.bytes) - Number(b.bytes),
          ratio: Number(b.bytes) === 0 ? null : Number((Number(a.bytes) / Number(b.bytes)).toFixed(2)),
          columnsNotOnThisTable: missing,
        });
      }
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }

  const pad = (v, n) => String(v).padStart(n);
  console.log(
    "id".padEnd(32) + pad("rows", 6) + pad("cols", 6) + pad("proj", 6) + pad("bytes", 10) + pad("projected", 11) + pad("x", 7),
  );
  for (const r of rows)
    console.log(
      r.id.padEnd(32) + pad(r.rows, 6) + pad(r.fullColumns, 6) + pad(r.projectedColumns, 6) +
        pad(r.fullBytes, 10) + pad(r.projectedBytes, 11) + pad(r.ratio ?? "-", 7) +
        (r.rows === 0 ? "   (no rows for this tenant — not evidence)" : ""),
    );
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/projection-bytes-${orgLabel}.json`, `${JSON.stringify(rows, null, 1)}\n`);
  return 0;
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
