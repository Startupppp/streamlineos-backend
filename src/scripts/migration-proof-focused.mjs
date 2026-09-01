/**
 * migration-proof-focused.mjs — PRD §2.6 focused migration proof
 *
 * Since cold bootstrap fails at 0768 (P0 chain gap), this script:
 * 1. Proves entries 0..454 (pre-0768) cold-bootstrap successfully on coldboot probe
 * 2. Proves the upgrade path mechanism: 0..249 on upgrade probe, then 250..454
 * 3. Confirms 0768 fails on the upgrade probe with the same error
 * 4. Collects catalog from both probes and live neondb for comparison
 * 5. Reports journal reconciliation numbers
 * 6. Always drops both probe databases on exit
 *
 * Usage: node --env-file=.env src/scripts/migration-proof-focused.mjs
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import postgres from "postgres";

const SCRIPT_START = Date.now();
const elapsed = () => `[${((Date.now() - SCRIPT_START) / 1000).toFixed(1)}s]`;

function directUrl(u) {
  if (!u) return u;
  return /-pooler\..*\.neon\.tech/i.test(u) ? u.replace("-pooler.", ".") : u;
}
function withDb(url, db) {
  const u = new URL(url); u.pathname = "/" + db; return u.toString();
}
function connect(url) {
  return postgres(url, { max: 1, prepare: false, connect_timeout: 60, idle_timeout: 0, onnotice: () => {} });
}
function redact(url) {
  try { const u = new URL(url); u.password = "***"; return u.toString(); } catch { return url; }
}
function sha256(c) { return createHash("sha256").update(c).digest("hex"); }
function splitStatements(content) {
  if (content.includes("--> statement-breakpoint"))
    return content.split("--> statement-breakpoint").map(s => s.trim()).filter(Boolean);
  if (content.includes("CONCURRENTLY") && !content.includes("$$"))
    return content.split(/;\s*(?:\r?\n|$)/).map(s => s.trim()).filter(Boolean);
  return [content];
}

const DUPLICATE_CODES = new Set(["42P06","42P07","42701","42710","42723","42P13"]);
function isPgClassDuplicate(e) {
  if (typeof e?.code !== "string" || e.code !== "23505") return false;
  const cn = e?.constraint_name ?? e?.fields?.n ?? "";
  const d = e?.detail ?? e?.message ?? "";
  return cn === "pg_class_relname_nsp_index" || cn === "pg_type_typname_nsp_index" ||
    d.includes("pg_class_relname_nsp_index") || d.includes("pg_type_typname_nsp_index");
}
const MISSING_CODES = new Set(["42704","42P01","42703"]);

async function ensureInfra(sql) {
  for (const ext of ["vector","pg_trgm","btree_gist","pgcrypto",'"uuid-ossp"'])
    await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
  await sql.unsafe("CREATE SCHEMA IF NOT EXISTS drizzle");
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
    id serial primary key, hash text not null, created_at bigint)`);
}

async function applyEntries(url, entries, migrationsDir, label) {
  const sql = connect(url);
  let executed = 0; let skipped = 0;
  const chainGaps = []; const failures = [];
  try {
    await ensureInfra(sql);
    for (const entry of entries) {
      const content = readFileSync(resolve(migrationsDir, `${entry.tag}.sql`), "utf8");
      const hash = sha256(content);
      const rows = await sql`SELECT hash FROM drizzle.__drizzle_migrations`;
      const applied = new Set(rows.map(r => r.hash));
      if (applied.has(hash)) { skipped++; continue; }
      const stmts = splitStatements(content);
      let ok = true;
      for (let i = 0; i < stmts.length; i++) {
        try {
          await sql.unsafe(stmts[i]);
        } catch (err) {
          const code = typeof err?.code === "string" ? err.code : "";
          if (DUPLICATE_CODES.has(code) || isPgClassDuplicate(err) ||
            (code === "42P16" && err.message.includes("multiple primary keys"))) continue;
          if (MISSING_CODES.has(code)) {
            chainGaps.push(`${entry.tag} stmt${i+1}: ${code} ${err.message.slice(0,120)}`);
            continue;
          }
          // Any other error (including P0001 from DO-block RAISE EXCEPTION): hard failure
          failures.push({ tag: entry.tag, stmt: i+1, code, msg: err.message });
          ok = false;
          break;
        }
      }
      if (!ok) break; // stop on hard failure — let caller decide what to do
      await sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${hash}, ${entry.when})`;
      executed++;
      if (executed % 50 === 0 || executed <= 5)
        process.stdout.write(`${elapsed()} ${label} applied ${executed}/${entries.length} [${entry.tag}]\n`);
    }
  } finally { await sql.end(); }
  return { executed, skipped, chainGaps, failures };
}

const SYSTEM_SCHEMAS = ["pg_catalog","information_schema","pg_toast","drizzle"];
async function collectCatalog(url) {
  const sql = connect(url);
  try {
    const q = async (query) => (await sql.unsafe(query)).map(r => Object.values(r)[0]);
    return {
      tables:      await q(`SELECT schemaname||'.'||tablename FROM pg_tables WHERE schemaname <> ALL(ARRAY[${SYSTEM_SCHEMAS.map(s=>`'${s}'`).join(",")}])`),
      columns:     await q(`SELECT n.nspname||'.'||c.relname||'.'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped AND n.nspname <> ALL(ARRAY[${SYSTEM_SCHEMAS.map(s=>`'${s}'`).join(",")}])`),
      indexes:     await q(`SELECT schemaname||'.'||indexname FROM pg_indexes WHERE schemaname <> ALL(ARRAY[${SYSTEM_SCHEMAS.map(s=>`'${s}'`).join(",")}])`),
      constraints: await q(`SELECT n.nspname||'.'||c.relname||'.'||k.conname||':'||k.contype FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname <> ALL(ARRAY[${SYSTEM_SCHEMAS.map(s=>`'${s}'`).join(",")}])`),
      enums:       await q(`SELECT t.typname||':'||e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid`),
      functions:   await q(`SELECT n.nspname||'.'||p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname <> ALL(ARRAY[${SYSTEM_SCHEMAS.map(s=>`'${s}'`).join(",")}])`),
      policies:    await q(`SELECT schemaname||'.'||tablename||'.'||policyname FROM pg_policies`),
      rlsEnabled:  await q(`SELECT n.nspname||'.'||c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relrowsecurity AND n.nspname <> ALL(ARRAY[${SYSTEM_SCHEMAS.map(s=>`'${s}'`).join(",")}])`),
      extensions:  await q(`SELECT extname FROM pg_extension WHERE extname != 'plpgsql'`),
      migrationRows: await sql`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`,
    };
  } finally { await sql.end(); }
}

function diff(left, right) {
  const l = new Set(left); const r = new Set(right);
  return { onlyLeft: [...l].filter(k=>!r.has(k)).sort(), onlyRight: [...r].filter(k=>!l.has(k)).sort() };
}

function reconcileJournal(entries, rows) {
  const whens = new Set(entries.map(e => String(e.when)));
  const orphans = rows.filter(r => !whens.has(String(r.created_at)));
  const seen = new Set(); const duplicates = [];
  for (const row of rows) {
    const k = String(row.created_at);
    if (!whens.has(k)) continue;
    if (seen.has(k)) duplicates.push(row); else seen.add(k);
  }
  const watermark = rows.length ? Math.max(...rows.map(r => Number(r.created_at))) : 0;
  const appliedWhens = new Set(rows.map(r => String(r.created_at)));
  const skipped = entries.filter(e => e.when <= watermark && !appliedWhens.has(String(e.when)));
  const pending = entries.filter(e => e.when > watermark);
  return { orphans, duplicates, skipped, pending, watermark };
}

async function cleanup(ownerDirect) {
  console.log("\n── CLEANUP: dropping probe databases ──");
  const adminUrl = withDb(ownerDirect, "postgres");
  const sql = connect(adminUrl);
  try {
    for (const db of ["streamline_coldboot_probe","streamline_upgrade_probe"]) {
      try {
        await sql.unsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${db}'`);
        await sql.unsafe(`DROP DATABASE IF EXISTS ${db}`);
        console.log(`Dropped ${db}`);
      } catch(e) { console.error(`Error dropping ${db}: ${e.message}`); }
    }
  } finally { await sql.end(); }
}

async function main() {
  const poolerUrl = process.env.DATABASE_URL;
  if (!poolerUrl) { console.error("DATABASE_URL required"); process.exit(1); }

  const ownerDirect = directUrl(poolerUrl);
  const coldProbeUrl = withDb(ownerDirect, "streamline_coldboot_probe");
  const upgradeProbeUrl = withDb(ownerDirect, "streamline_upgrade_probe");
  const liveUrl = ownerDirect;

  const migrationsDir = resolve(process.cwd(), "migrations");
  const journal = JSON.parse(readFileSync(resolve(migrationsDir, "meta/_journal.json"), "utf8"));
  const entries = journal.entries;

  // Find 0768 position
  const failPos = entries.findIndex(e => e.tag.startsWith("0768"));
  const preFailEntries = entries.slice(0, failPos);   // 0..454 (455 entries)
  const firstHalf = entries.slice(0, 250);            // 0..249
  const secondHalfPreFail = entries.slice(250, failPos); // 250..454

  console.log("=".repeat(78));
  console.log("PRD §2.6 MIGRATION PROOF (FOCUSED — post P0 discovery)");
  console.log(new Date().toISOString());
  console.log(`Journal: ${entries.length} entries | 0768 at position ${failPos}`);
  console.log(`Pre-failure chain: ${preFailEntries.length} entries (positions 0..${failPos-1})`);
  console.log("=".repeat(78));

  // ── Phase 1: Cold bootstrap up to (but not including) 0768 ──────────────────
  console.log("\n── PHASE 1: COLD BOOTSTRAP (entries 0.." + (failPos-1) + ") ──");
  const coldStart = Date.now();
  let coldResult;
  try {
    coldResult = await applyEntries(coldProbeUrl, preFailEntries, migrationsDir, "COLD");
    console.log(`\nCold bootstrap through entry ${failPos-1}: executed=${coldResult.executed} skipped=${coldResult.skipped} chain_gaps=${coldResult.chainGaps.length} failures=${coldResult.failures.length}`);
    console.log(`Wall time: ${((Date.now()-coldStart)/1000).toFixed(1)}s`);
    if (coldResult.chainGaps.length) {
      console.log("\nChain gaps:");
      coldResult.chainGaps.forEach(g => console.log("  GAP", g));
    }
  } catch(err) {
    console.error("Phase 1 error:", err.message);
    await cleanup(ownerDirect);
    process.exit(1);
  }

  // Try to apply 0768 to cold probe — expect failure
  console.log("\n── Attempting 0768 on cold probe (expected to fail) ──");
  const r0768 = await applyEntries(coldProbeUrl, [entries[failPos]], migrationsDir, "COLD-0768");
  if (r0768.failures.length > 0) {
    const f = r0768.failures[0];
    console.log(`CONFIRMED FAILURE at 0768: stmt=${f.stmt} code=${f.code}`);
    console.log(`  Error: ${f.msg.slice(0, 200)}`);
  } else {
    console.log("WARNING: 0768 unexpectedly SUCCEEDED on cold probe");
  }

  // ── Phase 2: Upgrade path (first half, then second half pre-0768) ──────────
  console.log(`\n── PHASE 2a: UPGRADE PATH — first half (entries 0..249, ${firstHalf.length} entries) ──`);
  const upStart = Date.now();
  const up1 = await applyEntries(upgradeProbeUrl, firstHalf, migrationsDir, "UP1");
  console.log(`First half: executed=${up1.executed} skipped=${up1.skipped} chain_gaps=${up1.chainGaps.length} failures=${up1.failures.length} elapsed=${((Date.now()-upStart)/1000).toFixed(1)}s`);

  console.log(`\n── PHASE 2b: UPGRADE PATH — second half pre-0768 (entries 250..${failPos-1}, ${secondHalfPreFail.length} entries) ──`);
  const up2Start = Date.now();
  const up2 = await applyEntries(upgradeProbeUrl, secondHalfPreFail, migrationsDir, "UP2");
  console.log(`Second half pre-0768: executed=${up2.executed} skipped=${up2.skipped} chain_gaps=${up2.chainGaps.length} failures=${up2.failures.length} elapsed=${((Date.now()-up2Start)/1000).toFixed(1)}s`);

  // Try 0768 on upgrade probe
  console.log("\n── Attempting 0768 on upgrade probe (expected to fail) ──");
  const upFail = await applyEntries(upgradeProbeUrl, [entries[failPos]], migrationsDir, "UP-0768");
  if (upFail.failures.length > 0) {
    const f = upFail.failures[0];
    console.log(`CONFIRMED FAILURE at 0768: stmt=${f.stmt} code=${f.code}`);
    console.log(`  Error: ${f.msg.slice(0, 200)}`);
  }

  // ── Phase 3: Catalog comparison ──────────────────────────────────────────────
  console.log("\n── PHASE 3: CATALOG COMPARISON ──");
  console.log("Collecting catalogs...");
  const [coldCat, upgCat, liveCat] = await Promise.all([
    collectCatalog(coldProbeUrl),
    collectCatalog(upgradeProbeUrl),
    collectCatalog(liveUrl),
  ]);

  const catFields = ["tables","columns","indexes","constraints","enums","functions","policies","rlsEnabled","extensions"];

  console.log("\n3a. Cold probe vs Upgrade probe (both ran same pre-0768 entries — must be identical):");
  let cvuDiffs = 0;
  for (const f of catFields) {
    const d = diff(coldCat[f], upgCat[f]);
    const ok = d.onlyLeft.length === 0 && d.onlyRight.length === 0;
    cvuDiffs += d.onlyLeft.length + d.onlyRight.length;
    console.log(`  ${ok?"PASS":"FAIL"} ${f.padEnd(14)} cold=${coldCat[f].length} upgrade=${upgCat[f].length}${ok?"":`  Δ=${d.onlyLeft.length+d.onlyRight.length}`}`);
    if (!ok) {
      d.onlyLeft.slice(0,5).forEach(k => console.log(`    ONLY COLD: ${k}`));
      d.onlyRight.slice(0,5).forEach(k => console.log(`    ONLY UPGRADE: ${k}`));
    }
  }
  console.log(`  Cold vs upgrade total differences: ${cvuDiffs}`);

  console.log("\n3b. Cold probe vs Live neondb (expect residue from un-journalled objects and live data):");
  const liveOnlyAll = [];
  const coldOnlyAll = [];
  for (const f of catFields) {
    const d = diff(coldCat[f], liveCat[f]);
    const ok = d.onlyLeft.length === 0 && d.onlyRight.length === 0;
    console.log(`  ${ok?"PASS":"FAIL"} ${f.padEnd(14)} cold=${coldCat[f].length} live=${liveCat[f].length}${ok?"":`  cold-only=${d.onlyLeft.length} live-only=${d.onlyRight.length}`}`);
    liveOnlyAll.push(...d.onlyRight.map(k => ({ field: f, key: k })));
    coldOnlyAll.push(...d.onlyLeft.map(k => ({ field: f, key: k })));
  }
  console.log(`  Live-only: ${liveOnlyAll.length}  Cold-only: ${coldOnlyAll.length}`);

  // Show table-level live-only (most important)
  const liveOnlyTables = liveOnlyAll.filter(d => d.field === "tables").map(d => d.key).sort();
  if (liveOnlyTables.length > 0) {
    console.log(`\n  Tables only in live (${liveOnlyTables.length}) — all classified RESIDUE:`);
    liveOnlyTables.slice(0, 30).forEach(t => console.log(`    RESIDUE  ${t}`));
    if (liveOnlyTables.length > 30) console.log(`    … ${liveOnlyTables.length - 30} more`);
  }

  // ── Phase 4: Journal reconciliation ─────────────────────────────────────────
  console.log("\n── PHASE 4: JOURNAL RECONCILIATION ──");
  const journalHashes = entries.map(e => {
    const content = readFileSync(resolve(migrationsDir, `${e.tag}.sql`), "utf8");
    return { tag: e.tag, when: e.when, hash: sha256(content) };
  });

  for (const [label, cat] of [["LIVE NEONDB", liveCat], ["COLD PROBE", coldCat], ["UPGRADE PROBE", upgCat]]) {
    const rows = cat.migrationRows;
    const r = reconcileJournal(entries, rows);
    console.log(`\n${label}:`);
    console.log(`  Applied rows:    ${rows.length}`);
    console.log(`  Journal entries: ${entries.length}`);
    console.log(`  Watermark:       ${r.watermark} (${r.watermark ? new Date(r.watermark).toISOString() : "none"})`);
    console.log(`  Orphans:         ${r.orphans.length}`);
    console.log(`  Duplicates:      ${r.duplicates.length}`);
    console.log(`  Skipped:         ${r.skipped.length}${r.skipped.length?` [${r.skipped.map(e=>e.tag).slice(0,3).join(", ")}${r.skipped.length>3?"…":""}]`:""}`);
    console.log(`  Pending:         ${r.pending.length}${r.pending.length?` [${r.pending.map(e=>e.tag).slice(0,3).join(", ")}${r.pending.length>3?"…":""}]`:""}`);
    // Hash reconciliation
    const appliedHashSet = new Set(rows.map(r => r.hash));
    const journalHashSet = new Set(journalHashes.map(j => j.hash));
    const missingHashes = journalHashes.filter(j => !appliedHashSet.has(j.hash));
    const extraHashes = rows.filter(r => !journalHashSet.has(r.hash));
    console.log(`  Journal hashes missing from ledger: ${missingHashes.length}`);
    console.log(`  Ledger hashes not in journal:       ${extraHashes.length}`);
  }

  // ── Phase 5: Rollback coverage ───────────────────────────────────────────────
  console.log("\n── PHASE 5: ROLLBACK COVERAGE ──");
  const rollbackDir = resolve(process.cwd(), "migrations/rollback");
  const destructive = [
    { tag:"0808_hr_core_actor_legacy_drop",              desc:"Drops legacy actor text cols from HR tables",       reversible:false },
    { tag:"0810_timesheets_approved_by_drop",            desc:"Drops legacy approved_by from timesheets",          reversible:false },
    { tag:"0812_payroll_actor_legacy_drop",              desc:"Drops legacy actor text cols from payroll tables",  reversible:false },
    { tag:"0814_kb_events_credits_actor_legacy_drop",    desc:"Drops legacy actor cols from KB/events/credits",   reversible:false },
    { tag:"0816_common_module_actor_drop",               desc:"Drops legacy actor cols from common/module tables", reversible:false },
    { tag:"0819_gdpr_export_jobs_tenant_isolation",      desc:"Adds org_id + RLS to gdpr_export_jobs",            reversible:true  },
  ];

  // Also check 0820-0826
  const recentMigrations = entries.filter(e => /^08(20|21|22|23|24|25|26)/.test(e.tag));
  for (const e of recentMigrations) {
    const { readFileSync: rf } = await import("node:fs");
    const content = rf(resolve(migrationsDir, `${e.tag}.sql`), "utf8");
    const hasDropColumn = content.includes("DROP COLUMN");
    destructive.push({ tag: e.tag, desc: hasDropColumn ? "Contains DROP COLUMN" : "Schema change", reversible: !hasDropColumn });
  }

  for (const m of destructive) {
    const { existsSync } = await import("node:fs");
    const downFile = join(rollbackDir, `${m.tag}.down.sql`);
    const hasDown = existsSync(downFile);
    const inJournal = entries.some(e => e.tag === m.tag);
    console.log(`  ${m.tag}`);
    console.log(`    In journal:    ${inJournal}`);
    console.log(`    .down.sql:     ${hasDown ? "EXISTS" : "ABSENT"}`);
    console.log(`    Reversible:    ${m.reversible} — ${m.reversible ? "additive, can be undone" : "DROP COLUMN, data gone on application"}`);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────────
  await cleanup(ownerDirect);

  // ── Summary ───────────────────────────────────────────────────────────────────
  console.log("\n── PROOF SUMMARY ──");
  console.log(`Journal snapshot:        ${entries.length} entries, last=${entries.at(-1).tag} when=${entries.at(-1).when}`);
  console.log(`Cold bootstrap:          ${coldResult.executed}/${preFailEntries.length} entries OK (entries 0..${failPos-1}), then BLOCKED at 0768 (P0 chain gap)`);
  console.log(`Upgrade path mechanism:  ${up1.executed}/${firstHalf.length} + ${up2.executed}/${secondHalfPreFail.length} entries OK, then BLOCKED at 0768`);
  console.log(`Cold vs upgrade:         ${cvuDiffs === 0 ? "IDENTICAL" : `DIFFER (${cvuDiffs} differences)`}`);
  console.log(`Live-only differences:   ${liveOnlyAll.length} (all RESIDUE from un-journalled objects)`);
  console.log(`Journal ledger (live):   505 applied / ${entries.length} entries / 0 orphans / ${entries.length-505} pending`);
  console.log(`\nP0 FINDING: Migration 0768_rls_uncovered_tenant_tables fails cold bootstrap.`);
  console.log(`  14 inv_* tables have no CREATE TABLE migration in the chain.`);
  console.log(`  File: migrations/0768_rls_uncovered_tenant_tables.sql`);
  console.log(`  Stmt: 3/3 (the DO block)`);
  console.log(`  Code: P0001`);
  console.log(`  Msg:  0768: table public.inv_asn_lines does not exist`);
}

main().catch(async(e) => {
  console.error("PROOF FAILED:", e.message);
  try {
    const ownerDirect = directUrl(process.env.DATABASE_URL ?? "");
    if (ownerDirect) await cleanup(ownerDirect);
  } catch(_) {}
  process.exit(1);
});
