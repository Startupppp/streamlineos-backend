/**
 * Generate CREATE TABLE SQL for the 30 push-created inv_* tables from pg_catalog.
 * Outputs to stdout; redirect to the migration file.
 *
 * Usage: node src/scripts/emit-inv-tables.mjs > migrations/0767b_inv_table_chain_repair.sql
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { connect } from "./chain-repair/catalog-read.mjs";
import {
  createTable,
  addConstraint,
  createIndex,
  grantAppRole,
  section,
} from "./chain-repair/emit-ddl.mjs";

const envContent = readFileSync(resolve(process.cwd(), ".env"), "utf8");
const dbUrlMatch = envContent.match(/^DATABASE_URL=(.+)$/m);
if (!dbUrlMatch) { process.stderr.write("No DATABASE_URL in .env\n"); process.exit(1); }
const DATABASE_URL = dbUrlMatch[1].trim().replace(/^["']|["']$/g, "");
const directUrl = DATABASE_URL.replace("-pooler.", ".");

const APP_ROLE = "streamline_app";

// All 30 push-created inv_* tables (confirmed via pg_catalog vs migration grep)
const TARGET_TABLES = [
  "inv_ai_feedback",
  "inv_allocation_overrides",
  "inv_asn_lines",
  "inv_asns",
  "inv_audit_export_jobs",
  "inv_channel_pools",
  "inv_channel_snapshot_diffs",
  "inv_channel_webhook_deliveries",
  "inv_customer_shelf_life_rules",
  "inv_demand_forecasts",
  "inv_dock_appointments",
  "inv_dock_doors",
  "inv_grn_line_serials",
  "inv_handling_units",
  "inv_inspection_plan_versions",
  "inv_inspection_plans",
  "inv_kit_components",
  "inv_labor_records",
  "inv_landed_cost_allocations",
  "inv_landed_cost_charges",
  "inv_landed_cost_vouchers",
  "inv_platform_payout_lines",
  "inv_platform_po_lines",
  "inv_platform_purchase_orders",
  "inv_proposal_overrides",
  "inv_putaway_task_lines",
  "inv_putaway_tasks",
  "inv_slotting_recommendations",
  "inv_slotting_rules",
  "inv_velocity_classes",
];

const sql = connect(directUrl);

try {
  const [tableRows, columnRows, constraintRows, indexRows] = await Promise.all([
    sql`
      SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname = 'public'
        AND c.relname = ANY(${TARGET_TABLES})
      ORDER BY c.relname
    `,
    sql`
      SELECT n.nspname AS schema, c.relname AS table_name, a.attname AS name,
             a.attnum AS ord, format_type(a.atttypid, a.atttypmod) AS type,
             a.attnotnull AS notnull, a.attidentity AS identity, a.attgenerated AS generated,
             pg_get_expr(d.adbin, d.adrelid) AS default_expr,
             (SELECT cl.collname FROM pg_collation cl
               WHERE cl.oid = a.attcollation AND a.attcollation <> t.typcollation) AS collation
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_type t ON t.oid = a.atttypid
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
        AND n.nspname = 'public' AND c.relname = ANY(${TARGET_TABLES})
      ORDER BY c.relname, a.attnum
    `,
    sql`
      SELECT n.nspname AS schema, c.relname AS table_name, k.conname AS name,
             k.contype::text AS type, pg_get_constraintdef(k.oid) AS def
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY(${TARGET_TABLES})
        AND k.contype <> 't'
      ORDER BY c.relname, k.contype, k.conname
    `,
    sql`
      SELECT n.nspname AS schema, t.relname AS table_name, i.relname AS name,
             pg_get_indexdef(x.indexrelid) AS def,
             EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conindid = x.indexrelid) AS backs_constraint
      FROM pg_index x
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_class t ON t.oid = x.indrelid
      JOIN pg_namespace n ON n.oid = i.relnamespace
      WHERE n.nspname = 'public' AND t.relname = ANY(${TARGET_TABLES})
      ORDER BY t.relname, i.relname
    `,
  ]);

  const tables = tableRows.map(r => ({
    key: `${r.schema}.${r.name}`,
    schema: String(r.schema),
    name: String(r.name),
    kind: String(r.kind),
    parent: null,
  }));

  const columnsByTable = new Map();
  for (const r of columnRows) {
    const key = `public.${r.table_name}`;
    if (!columnsByTable.has(key)) columnsByTable.set(key, []);
    columnsByTable.get(key).push({
      schema: String(r.schema),
      table: String(r.table_name),
      name: String(r.name),
      ord: Number(r.ord),
      type: String(r.type),
      notnull: r.notnull === true,
      identity: String(r.identity ?? ""),
      generated: String(r.generated ?? ""),
      defaultExpr: r.default_expr === null ? null : String(r.default_expr),
      collation: r.collation === null ? null : String(r.collation),
    });
  }

  const constraintsByTable = new Map();
  for (const r of constraintRows) {
    const key = `public.${r.table_name}`;
    if (!constraintsByTable.has(key)) constraintsByTable.set(key, []);
    constraintsByTable.get(key).push({
      schema: String(r.schema),
      table: String(r.table_name),
      name: String(r.name),
      type: String(r.type),
      def: String(r.def),
    });
  }

  const indexesByTable = new Map();
  for (const r of indexRows) {
    const key = `public.${r.table_name}`;
    if (!indexesByTable.has(key)) indexesByTable.set(key, []);
    indexesByTable.get(key).push({
      schema: String(r.schema),
      table: String(r.table_name),
      name: String(r.name),
      def: String(r.def),
      backsConstraint: r.backs_constraint === true,
    });
  }

  const BREAK = "--> statement-breakpoint";
  const parts = [
    "-- Chain repair: 30 inv_* tables created with drizzle-kit push and never migrated.",
    "--",
    "-- The live database has these tables but pnpm db:migrate cannot build a fresh",
    "-- database because no CREATE TABLE migration exists. Migration 0768 explicitly",
    "-- checks for 14 of them and raises P0001 when absent, blocking every cold bootstrap.",
    "--",
    "-- All 30 push-created inv_* tables are reproduced here with full column/type/default",
    "-- fidelity from pg_catalog. Every statement is idempotent (IF NOT EXISTS / guarded DO).",
    "-- RLS is intentionally omitted -- 0768_rls_uncovered_tenant_tables handles that.",
    "--",
    "-- Placement: when=1798000079500, between 0767 (when=1798000079000) and",
    "-- 0768 (when=1798000080000). The live DB watermark is 1798000131000,",
    "-- so this entry is below-watermark on the live DB and requires a ledger backfill INSERT.",
    "--",
    "-- Generated from pg_catalog by src/scripts/emit-inv-tables.mjs.",
    "",
    "SET statement_timeout = 0;",
    BREAK,
    "SET lock_timeout = '5s';",
  ];

  // Phase 1: CREATE TABLE for all tables (IF NOT EXISTS — idempotent).
  // All tables must exist before any FK constraint is added, because some inv_*
  // tables FK to other inv_* tables (e.g. inv_asn_lines -> inv_asns).
  parts.push(BREAK);
  parts.push(section("Phase 1: CREATE TABLE (all 30 inv_* tables)"));
  for (const table of tables) {
    const cols = columnsByTable.get(table.key) ?? [];
    parts.push(BREAK);
    parts.push(createTable(table, cols));
  }

  // Phase 2: Non-FK constraints (PK, UNIQUE, CHECK) — guarded DO blocks, idempotent.
  parts.push(BREAK);
  parts.push(section("Phase 2: primary key, unique and check constraints"));
  for (const table of tables) {
    const constraints = constraintsByTable.get(table.key) ?? [];
    for (const c of constraints.filter(c => c.type !== "f")) {
      parts.push(BREAK);
      parts.push(addConstraint(c));
    }
  }

  // Phase 3: Indexes (non-constraint) — IF NOT EXISTS, idempotent.
  parts.push(BREAK);
  parts.push(section("Phase 3: indexes"));
  for (const table of tables) {
    const indexes = indexesByTable.get(table.key) ?? [];
    for (const idx of indexes.filter(i => !i.backsConstraint)) {
      parts.push(BREAK);
      let def = idx.def;
      def = def.replace(/^CREATE INDEX /, "CREATE INDEX IF NOT EXISTS ");
      def = def.replace(/^CREATE UNIQUE INDEX /, "CREATE UNIQUE INDEX IF NOT EXISTS ");
      if (!def.endsWith(";")) def += ";";
      parts.push(def);
    }
  }

  // Phase 4: FK constraints (NOT VALID, guarded DO blocks).
  // NOT VALID binds new writes without scanning existing rows. All 30 inv_* tables
  // now exist (phase 1), so inter-inv_* FKs can be added safely.
  // Use NOT VALID so the migration is a no-op on live (data already consistent)
  // and does not require a full table scan on a large table.
  parts.push(BREAK);
  parts.push(section("Phase 4: foreign keys (NOT VALID — binds new writes, skips historical scan)"));
  for (const table of tables) {
    const constraints = constraintsByTable.get(table.key) ?? [];
    for (const c of constraints.filter(c => c.type === "f")) {
      parts.push(BREAK);
      parts.push(addConstraint({ ...c, def: c.def + " NOT VALID" }));
    }
  }

  // Phase 5: Grant app role (REVOKE ALL from PUBLIC, GRANT to streamline_app).
  parts.push(BREAK);
  parts.push(section("Phase 5: app role grants"));
  for (const table of tables) {
    parts.push(BREAK);
    parts.push(grantAppRole(table, APP_ROLE));
  }

  process.stdout.write(parts.join("\n") + "\n");
  process.stderr.write(
    `Generated DDL for ${tables.length} tables, ${columnRows.length} columns, ` +
    `${constraintRows.length} constraints, ${indexRows.length} indexes\n`
  );
} finally {
  await sql.end();
}
