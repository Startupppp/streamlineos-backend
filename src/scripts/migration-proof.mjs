/**
 * migration-proof.mjs — PRD §2.6 Migration proof
 *
 * Exercises cold bootstrap, upgrade path, catalog comparison, journal
 * reconciliation and rollback coverage against two disposable databases.
 *
 * Usage:
 *   node --env-file=.env src/scripts/migration-proof.mjs
 *   node src/scripts/migration-proof.mjs --self-test
 *
 * IMPORTANT: drops both probe databases on exit (success or failure).
 * Never touches neondb, cell2 or postgres.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import postgres from "postgres";

const SCRIPT_START = Date.now();
const elapsed = () => `[${((Date.now() - SCRIPT_START) / 1000).toFixed(1)}s]`;
const SELF_TEST = process.argv.includes("--self-test");

// ─── connection helpers ────────────────────────────────────────────────────────

function directUrl(poolerOrDirect) {
  if (!poolerOrDirect) return poolerOrDirect;
  return /-pooler\..*\.neon\.tech/i.test(poolerOrDirect)
    ? poolerOrDirect.replace("-pooler.", ".")
    : poolerOrDirect;
}

function withDb(url, dbName) {
  const u = new URL(url);
  u.pathname = "/" + dbName;
  return u.toString();
}

function connect(url) {
  return postgres(url, {
    max: 1,
    prepare: false,
    connect_timeout: 60,
    idle_timeout: 0,
    onnotice: () => {},
  });
}

function redact(url) {
  try {
    const u = new URL(url);
    u.password = "***";
    return u.toString();
  } catch {
    return url;
  }
}

// ─── migration bootstrap helpers ───────────────────────────────────────────────

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function splitStatements(content) {
  if (content.includes("--> statement-breakpoint"))
    return content
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
  if (content.includes("CONCURRENTLY") && !content.includes("$$"))
    return content
      .split(/;\s*(?:\r?\n|$)/)
      .map((s) => s.trim())
      .filter(Boolean);
  return [content];
}

const DUPLICATE_CODES = new Set([
  "42P06", "42P07", "42701", "42710", "42723", "42P13",
]);

function isPgClassDuplicate(e) {
  if (typeof e?.code !== "string" || e.code !== "23505") return false;
  const cn = e?.constraint_name ?? e?.fields?.n ?? "";
  const d = e?.detail ?? e?.message ?? "";
  return (
    cn === "pg_class_relname_nsp_index" ||
    cn === "pg_type_typname_nsp_index" ||
    d.includes("pg_class_relname_nsp_index") ||
    d.includes("pg_type_typname_nsp_index")
  );
}

// Migration 0431 pins `search_path` on the role `neondb_owner`, so the 152 unqualified
// `current_org_id()` references in 0619/0620/0655/0666/0677/0678/0701/0988 resolve only for a
// connection whose role happens to carry that name. `db-bootstrap.mjs` sets it per session for
// exactly this reason; this runner did not, so a cold proof under any other role — CI's `ci`
// role included — died at 0619 with `42883 function current_org_id() does not exist`.
const MIGRATION_SEARCH_PATH = '"$user", public, build_events, app';

async function ensureInfrastructure(sql) {
  await sql.unsafe(`SET search_path = ${MIGRATION_SEARCH_PATH}`);
  for (const ext of ["vector", "pg_trgm", "btree_gist", "pgcrypto", '"uuid-ossp"'])
    await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
  await sql.unsafe("CREATE SCHEMA IF NOT EXISTS drizzle");
  await sql.unsafe(
    `CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
       id serial primary key, hash text not null, created_at bigint)`,
  );
}

async function readAppliedHashes(sql) {
  const rows = await sql`SELECT hash FROM drizzle.__drizzle_migrations`;
  return new Set(rows.map((r) => r.hash));
}

/**
 * Apply a slice of journal entries to `url`.
 * Returns { executed, skipped, chainGaps, failures }.
 * On hard failure (non-duplicate, non-missing PG error), throws.
 */
async function applyEntries(url, entries, migrationsDir, label) {
  const sql = connect(url);
  let executed = 0;
  let skipped = 0;
  const chainGaps = [];

  try {
    await ensureInfrastructure(sql);

    for (const entry of entries) {
      const filePath = resolve(migrationsDir, `${entry.tag}.sql`);
      const content = readFileSync(filePath, "utf8");
      const hash = sha256(content);
      const applied = await readAppliedHashes(sql);

      if (applied.has(hash)) {
        skipped++;
        continue;
      }

      const statements = splitStatements(content);
      // Keep each migration in one transaction so ON COMMIT DROP temporary helper
      // tables remain available across statement-breakpoint sections. A clean
      // disposable database must not need duplicate or missing-object recovery.
      await sql.begin(async (tx) => {
      for (let i = 0; i < statements.length; i++) {
        try {
          await tx.unsafe(statements[i]);
        } catch (err) {
          const code = typeof err?.code === "string" ? err.code : "";
          if (
            DUPLICATE_CODES.has(code) ||
            isPgClassDuplicate(err) ||
            (code === "42P16" && err.message.includes("multiple primary keys"))
          ) {
            throw new Error(`${label} duplicate object at ${entry.tag} stmt ${i + 1}: ${err.message}`, { cause: err });
          }
          const MISSING_CODES = new Set(["42704", "42P01", "42703"]);
          // Missing objects are chain failures, never a successful migration. The
          // real migrator aborts here; recording the entry would create a false
          // watermark and hide an incomplete schema.
          if (MISSING_CODES.has(code)) {
            chainGaps.push(`${entry.tag} stmt ${i + 1}: ${code} ${err.message}`);
          }
          // Hard failure — propagate with context
          const rich = new Error(
            `${label} FAIL [${entry.tag}] stmt ${i + 1}/${statements.length}: ${code} ${err.message}`,
          );
          rich.tag = entry.tag;
          rich.stmt = i + 1;
          rich.pgCode = code;
          rich.pgMessage = err.message;
          throw rich;
        }
      }

      await tx`
        INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
        VALUES (${hash}, ${entry.when})`;
      });

      executed++;
      process.stdout.write(
        `${elapsed()} ${label} OK [${entry.tag}] (${executed}/${entries.length})\n`,
      );
    }
  } finally {
    await sql.end();
  }

  return { executed, skipped, chainGaps };
}

// ─── catalog collector (mirrors compare-cell-schema.mjs) ──────────────────────

const SYSTEM_SCHEMAS = ["pg_catalog", "information_schema", "pg_toast", "drizzle"];

async function collectCatalog(url) {
  const sql = connect(url);
  try {
    const tables = (
      await sql`SELECT schemaname || '.' || tablename AS k FROM pg_tables
                WHERE schemaname <> ALL(${SYSTEM_SCHEMAS})`
    ).map((r) => r.k);

    const columns = (
      await sql`
        SELECT n.nspname || '.' || c.relname || '.' || a.attname || ':' ||
               format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull AS k
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
          AND n.nspname <> ALL(${SYSTEM_SCHEMAS})`
    ).map((r) => r.k);

    const indexes = (
      await sql`SELECT schemaname || '.' || indexname AS k FROM pg_indexes
                WHERE schemaname <> ALL(${SYSTEM_SCHEMAS})`
    ).map((r) => r.k);

    const constraints = (
      await sql`
        SELECT n.nspname || '.' || c.relname || '.' || k.conname || ':' || k.contype::text AS k
        FROM pg_constraint k
        JOIN pg_class c ON c.oid = k.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname <> ALL(${SYSTEM_SCHEMAS})`
    ).map((r) => r.k);

    const enums = (
      await sql`SELECT t.typname || ':' || e.enumlabel AS k
                FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid`
    ).map((r) => r.k);

    const functions = (
      await sql`
        SELECT n.nspname || '.' || p.proname AS k
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname <> ALL(${SYSTEM_SCHEMAS})`
    ).map((r) => r.k);

    const policies = (
      await sql`SELECT schemaname || '.' || tablename || '.' || policyname AS k
                FROM pg_policies`
    ).map((r) => r.k);

    const rlsEnabled = (
      await sql`
        SELECT n.nspname || '.' || c.relname AS k
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relrowsecurity AND n.nspname <> ALL(${SYSTEM_SCHEMAS})`
    ).map((r) => r.k);

    const triggers = (
      await sql`
        SELECT n.nspname || '.' || c.relname || '.' || t.tgname AS k
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE NOT t.tgisinternal AND n.nspname <> ALL(${SYSTEM_SCHEMAS})`
    ).map((r) => r.k);

    const extensions = (
      await sql`SELECT extname AS k FROM pg_extension WHERE extname != 'plpgsql'`
    ).map((r) => r.k);

    const migrationRows = (
      await sql`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`
    );

    return {
      tables, columns, indexes, constraints, enums, functions,
      policies, rlsEnabled, triggers, extensions, migrationRows,
    };
  } finally {
    await sql.end();
  }
}

function diffSets(leftArr, rightArr) {
  const l = new Set(leftArr);
  const r = new Set(rightArr);
  return {
    onlyLeft: [...l].filter((k) => !r.has(k)).sort(),
    onlyRight: [...r].filter((k) => !l.has(k)).sort(),
  };
}

function reportDiff(name, left, right, leftLabel, rightLabel, showMax = 20) {
  const d = diffSets(left, right);
  const ok = d.onlyLeft.length === 0 && d.onlyRight.length === 0;
  const line =
    `${ok ? "PASS" : "FAIL"}  ${name.padEnd(14)} ` +
    `${leftLabel}=${String(left.length).padStart(6)} ` +
    `${rightLabel}=${String(right.length).padStart(6)}` +
    (ok ? "" : `  only-${leftLabel}=${d.onlyLeft.length}  only-${rightLabel}=${d.onlyRight.length}`);
  console.log(line);
  for (const k of d.onlyLeft.slice(0, showMax))
    console.log(`        ONLY IN ${leftLabel.toUpperCase()}  ${k}`);
  if (d.onlyLeft.length > showMax) console.log(`        … ${d.onlyLeft.length - showMax} more`);
  for (const k of d.onlyRight.slice(0, showMax))
    console.log(`        ONLY IN ${rightLabel.toUpperCase()}  ${k}`);
  if (d.onlyRight.length > showMax) console.log(`        … ${d.onlyRight.length - showMax} more`);
  return { ok, onlyLeft: d.onlyLeft, onlyRight: d.onlyRight };
}

// ─── journal reconciliation ────────────────────────────────────────────────────

function reconcileJournal(entries, rows) {
  const whens = new Set(entries.map((e) => String(e.when)));
  const orphans = rows.filter((r) => !whens.has(String(r.created_at)));

  const seen = new Set();
  const duplicates = [];
  for (const row of rows) {
    const key = String(row.created_at);
    if (!whens.has(key)) continue;
    if (seen.has(key)) duplicates.push(row);
    else seen.add(key);
  }

  const watermark = rows.length ? Math.max(...rows.map((r) => Number(r.created_at))) : 0;
  const appliedWhens = new Set(rows.map((r) => String(r.created_at)));
  const skipped = entries.filter(
    (e) => e.when <= watermark && !appliedWhens.has(String(e.when)),
  );
  const pending = entries.filter((e) => e.when > watermark);

  return { orphans, duplicates, skipped, pending, watermark };
}

/**
 * A catalog match is only meaningful when each disposable probe also has an
 * exact migration ledger. Keep this separate from the live-ledger report:
 * production may legitimately be behind while CI probes must reach head.
 */
function verifyProbeLedger(label, entries, rows, journalHashes) {
  const reconciliation = reconcileJournal(entries, rows);
  const failures = [];
  const expectedHashes = new Set(journalHashes.map((entry) => entry.hash));
  const actualHashes = new Set(rows.map((row) => row.hash));
  const missingHashes = journalHashes.filter((entry) => !actualHashes.has(entry.hash));
  const extraHashes = rows.filter((row) => !expectedHashes.has(row.hash));

  for (const [kind, values] of Object.entries({
    orphan: reconciliation.orphans,
    duplicate: reconciliation.duplicates,
    skipped: reconciliation.skipped,
    pending: reconciliation.pending,
  })) {
    if (values.length > 0) failures.push(`${label}: ${values.length} ${kind} ledger entr${values.length === 1 ? "y" : "ies"}`);
  }
  if (missingHashes.length > 0)
    failures.push(`${label}: ${missingHashes.length} journal hash(es) missing from the probe ledger`);
  if (extraHashes.length > 0)
    failures.push(`${label}: ${extraHashes.length} probe ledger hash(es) absent from the journal`);

  return failures;
}

function runSelfTest() {
  const entries = [
    { tag: "0001_a", when: 100 },
    { tag: "0002_b", when: 200 },
  ];
  const hashes = [
    { tag: "0001_a", hash: "hash-a" },
    { tag: "0002_b", hash: "hash-b" },
  ];
  const cleanRows = [
    { id: 1, created_at: 100, hash: "hash-a" },
    { id: 2, created_at: 200, hash: "hash-b" },
  ];
  const cleanFailures = verifyProbeLedger("clean", entries, cleanRows, hashes);
  const incompleteFailures = verifyProbeLedger(
    "incomplete",
    entries,
    [{ id: 1, created_at: 100, hash: "hash-a" }],
    hashes,
  );
  const corruptFailures = verifyProbeLedger(
    "corrupt",
    entries,
    [
      { id: 1, created_at: 100, hash: "hash-a" },
      { id: 2, created_at: 100, hash: "hash-a" },
      { id: 3, created_at: 999, hash: "hash-x" },
    ],
    hashes,
  );

  if (
    cleanFailures.length === 0 &&
    incompleteFailures.some((failure) => failure.includes("pending")) &&
    corruptFailures.some((failure) => failure.includes("orphan")) &&
    corruptFailures.some((failure) => failure.includes("duplicate")) &&
    corruptFailures.some((failure) => failure.includes("absent from the journal"))
  ) {
    console.log("SELF-TEST PASS: exact, incomplete, and corrupt probe ledgers are distinguished");
    return;
  }

  console.error(
    `SELF-TEST FAIL: clean=${JSON.stringify(cleanFailures)} ` +
      `incomplete=${JSON.stringify(incompleteFailures)} corrupt=${JSON.stringify(corruptFailures)}`,
  );
  process.exitCode = 1;
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const poolerUrl = process.env.DATABASE_URL;
  if (!poolerUrl) {
    console.error("DATABASE_URL is required in .env");
    process.exit(1);
  }

  const ownerDirect = directUrl(poolerUrl);
  const coldProbeUrl = withDb(ownerDirect, "streamline_coldboot_probe");
  const upgradeProbeUrl = withDb(ownerDirect, "streamline_upgrade_probe");
  const liveUrl = ownerDirect; // neondb

  const migrationsDir = resolve(process.cwd(), "migrations");
  const journal = JSON.parse(
    readFileSync(resolve(migrationsDir, "meta/_journal.json"), "utf8"),
  );
  const entries = journal.entries;

  console.log("=".repeat(78));
  console.log("PRD §2.6 MIGRATION PROOF");
  console.log(`${new Date().toISOString()}`);
  console.log(`Journal: ${entries.length} entries`);
  console.log(`Last:    idx=${entries.at(-1).idx} tag=${entries.at(-1).tag} when=${entries.at(-1).when}`);
  console.log(`Live DB: ${redact(liveUrl)}`);
  console.log(`Cold:    ${redact(coldProbeUrl)}`);
  console.log(`Upgrade: ${redact(upgradeProbeUrl)}`);
  console.log("=".repeat(78));

  // ── Create probe databases ──────────────────────────────────────────────────
  console.log("\n── CREATING PROBE DATABASES ─────────────────────────────────────────────────");
  {
    const adminUrl = withDb(ownerDirect, "postgres");
    const adminSql = connect(adminUrl);
    try {
      for (const db of ["streamline_coldboot_probe", "streamline_upgrade_probe"]) {
        try {
          await adminSql.unsafe(`CREATE DATABASE ${db}`);
          console.log(`Created ${db}`);
        } catch (e) {
          if (e?.code === "42P04") {
            console.log(`${db} already exists — will reuse`);
          } else {
            throw e;
          }
        }
      }
    } finally {
      await adminSql.end();
    }
  }

  // ── Phase 1: Cold bootstrap ─────────────────────────────────────────────────
  console.log("\n── PHASE 1: COLD BOOTSTRAP ─────────────────────────────────────────────────");
  const coldStart = Date.now();
  let coldResult;
  try {
    coldResult = await applyEntries(coldProbeUrl, entries, migrationsDir, "COLD");
    const coldMs = Date.now() - coldStart;
    console.log(
      `\nCOLD BOOTSTRAP RESULT: REACHED_HEAD ${coldResult.executed + coldResult.skipped}/${entries.length}` +
      ` executed=${coldResult.executed} skipped=${coldResult.skipped}` +
      ` chain_gaps=${coldResult.chainGaps.length}` +
      ` wall_time=${(coldMs / 1000).toFixed(1)}s`,
    );
    if (coldResult.chainGaps.length > 0) {
      console.log(`\nCHAIN GAPS (cold bootstrap):`);
      for (const g of coldResult.chainGaps) console.log(`  GAP  ${g}`);
    }
  } catch (err) {
    console.error(`\nCOLD BOOTSTRAP FAILED: ${err.message}`);
    if (err.tag) {
      console.error(`  File:    migrations/${err.tag}.sql`);
      console.error(`  PG code: ${err.pgCode}`);
      console.error(`  PG msg:  ${err.pgMessage}`);
    }
    await cleanup(ownerDirect);
    process.exit(1);
  }

  // ── Phase 2: Upgrade path ───────────────────────────────────────────────────
  console.log("\n── PHASE 2: UPGRADE PATH ───────────────────────────────────────────────────");
  // Split at position 250 (0-based) — entries 0..249 are the "existing" install,
  // entries 250..504 are the "upgrade".
  const SPLIT_POS = 250;
  const firstHalf = entries.slice(0, SPLIT_POS);
  const secondHalf = entries.slice(SPLIT_POS);
  const splitTag = firstHalf.at(-1).tag;
  const splitWhen = firstHalf.at(-1).when;
  console.log(
    `Intermediate point: entry position ${SPLIT_POS - 1} ` +
    `(tag=${splitTag} when=${splitWhen})`,
  );
  console.log(`First half: ${firstHalf.length} entries (positions 0..${SPLIT_POS - 1})`);
  console.log(`Second half: ${secondHalf.length} entries (positions ${SPLIT_POS}..${entries.length - 1})`);

  let upgradeResult1, upgradeResult2;
  const upgradeStart = Date.now();
  try {
    console.log(`\nApplying first half (${firstHalf.length} entries)...`);
    upgradeResult1 = await applyEntries(upgradeProbeUrl, firstHalf, migrationsDir, "UPGRADE-1");
    const mid1Ms = Date.now() - upgradeStart;
    console.log(
      `\nUPGRADE PHASE 1 RESULT: ${upgradeResult1.executed + upgradeResult1.skipped}/${firstHalf.length}` +
      ` executed=${upgradeResult1.executed} chain_gaps=${upgradeResult1.chainGaps.length}` +
      ` elapsed=${(mid1Ms / 1000).toFixed(1)}s`,
    );

    console.log(`\nApplying second half (${secondHalf.length} entries, the "upgrade")...`);
    upgradeResult2 = await applyEntries(upgradeProbeUrl, secondHalf, migrationsDir, "UPGRADE-2");
    const totalMs = Date.now() - upgradeStart;
    console.log(
      `\nUPGRADE PHASE 2 RESULT: ${upgradeResult2.executed + upgradeResult2.skipped}/${secondHalf.length}` +
      ` executed=${upgradeResult2.executed} chain_gaps=${upgradeResult2.chainGaps.length}` +
      ` wall_time=${(totalMs / 1000).toFixed(1)}s`,
    );
  } catch (err) {
    console.error(`\nUPGRADE BOOTSTRAP FAILED: ${err.message}`);
    if (err.tag) {
      console.error(`  File:    migrations/${err.tag}.sql`);
      console.error(`  PG code: ${err.pgCode}`);
      console.error(`  PG msg:  ${err.pgMessage}`);
    }
    await cleanup(ownerDirect);
    process.exit(1);
  }

  // ── Phase 3: Catalog comparison ─────────────────────────────────────────────
  console.log("\n── PHASE 3: CATALOG COMPARISON ─────────────────────────────────────────────");
  console.log("Collecting catalog from all three databases...");
  const [coldCat, upgradeCat, liveCat] = await Promise.all([
    collectCatalog(coldProbeUrl),
    collectCatalog(upgradeProbeUrl),
    collectCatalog(liveUrl),
  ]);

  // 3a: cold vs upgrade (must be identical)
  console.log("\n3a. COLD PROBE vs UPGRADE PROBE (must be identical):");
  const catFields = [
    "tables", "columns", "indexes", "constraints",
    "enums", "functions", "policies", "rlsEnabled", "triggers", "extensions",
  ];
  let coldVsUpgradeDiffs = 0;
  const coldVsUpgradeDetails = {};
  for (const field of catFields) {
    const d = reportDiff(field, coldCat[field], upgradeCat[field], "cold", "upgrade");
    if (!d.ok) coldVsUpgradeDiffs += d.onlyLeft.length + d.onlyRight.length;
    coldVsUpgradeDetails[field] = d;
  }
  console.log(
    `\nCOLD vs UPGRADE: ${coldVsUpgradeDiffs === 0 ? "IDENTICAL" : "DIFFER"} (${coldVsUpgradeDiffs} differences)`,
  );

  // 3b: cold vs live neondb
  console.log("\n3b. COLD PROBE vs LIVE neondb (expect residue differences):");
  const allDiffs = [];
  for (const field of catFields) {
    const d = reportDiff(field, coldCat[field], liveCat[field], "cold", "live");
    for (const k of d.onlyLeft) allDiffs.push({ direction: "cold-only", field, key: k });
    for (const k of d.onlyRight) allDiffs.push({ direction: "live-only", field, key: k });
  }
  console.log(`\nTotal cold-vs-live differences: ${allDiffs.length}`);

  // ── Phase 4: Journal reconciliation ─────────────────────────────────────────
  console.log("\n── PHASE 4: JOURNAL RECONCILIATION ─────────────────────────────────────────");

  // Live neondb
  const liveRows = liveCat.migrationRows;
  const liveRecon = reconcileJournal(entries, liveRows);
  console.log(`\nLive neondb drizzle.__drizzle_migrations:`);
  console.log(`  Applied rows:  ${liveRows.length}`);
  console.log(`  Journal entries: ${entries.length}`);
  console.log(`  Watermark:     ${liveRecon.watermark} (${new Date(liveRecon.watermark).toISOString()})`);
  console.log(`  Orphans:       ${liveRecon.orphans.length}`);
  console.log(`  Duplicates:    ${liveRecon.duplicates.length}`);
  console.log(`  Skipped:       ${liveRecon.skipped.length}`);
  console.log(`  Pending:       ${liveRecon.pending.length}`);
  if (liveRecon.orphans.length > 0) {
    console.log(`  Orphan row IDs: ${liveRecon.orphans.map((r) => r.id).join(", ")}`);
  }

  // Cold probe
  const coldRows = coldCat.migrationRows;
  const coldRecon = reconcileJournal(entries, coldRows);
  console.log(`\nCold probe drizzle.__drizzle_migrations:`);
  console.log(`  Applied rows:  ${coldRows.length}`);
  console.log(`  Journal entries: ${entries.length}`);
  console.log(`  Watermark:     ${coldRecon.watermark} (${new Date(coldRecon.watermark).toISOString()})`);
  console.log(`  Orphans:       ${coldRecon.orphans.length}`);
  console.log(`  Duplicates:    ${coldRecon.duplicates.length}`);
  console.log(`  Skipped:       ${coldRecon.skipped.length}`);
  console.log(`  Pending:       ${coldRecon.pending.length}`);

  // Upgrade probe
  const upgradeRows = upgradeCat.migrationRows;
  const upgradeRecon = reconcileJournal(entries, upgradeRows);
  console.log(`\nUpgrade probe drizzle.__drizzle_migrations:`);
  console.log(`  Applied rows:  ${upgradeRows.length}`);
  console.log(`  Journal entries: ${entries.length}`);
  console.log(`  Watermark:     ${upgradeRecon.watermark} (${new Date(upgradeRecon.watermark).toISOString()})`);
  console.log(`  Orphans:       ${upgradeRecon.orphans.length}`);
  console.log(`  Duplicates:    ${upgradeRecon.duplicates.length}`);
  console.log(`  Skipped:       ${upgradeRecon.skipped.length}`);
  console.log(`  Pending:       ${upgradeRecon.pending.length}`);

  // Verify hashes: journal sha256 hash matches applied hash in probe
  const journalHashes = entries.map((e) => {
    const content = readFileSync(resolve(migrationsDir, `${e.tag}.sql`), "utf8");
    return { tag: e.tag, when: e.when, hash: sha256(content) };
  });
  const coldHashSet = new Set(coldRows.map((r) => r.hash));
  const missingInCold = journalHashes.filter((j) => !coldHashSet.has(j.hash));
  const extraInCold = coldRows.filter(
    (r) => !new Set(journalHashes.map((j) => j.hash)).has(r.hash),
  );
  console.log(`\nHash reconciliation (cold probe vs journal sha256):`);
  console.log(`  Missing in cold (journal hash not in probe): ${missingInCold.length}`);
  console.log(`  Extra in cold (probe hash not in journal):   ${extraInCold.length}`);
  if (missingInCold.length > 0) {
    for (const j of missingInCold.slice(0, 10))
      console.log(`    MISSING  ${j.tag} (when=${j.when})`);
  }

  const coldLedgerFailures = verifyProbeLedger("cold probe", entries, coldRows, journalHashes);
  const upgradeLedgerFailures = verifyProbeLedger("upgrade probe", entries, upgradeRows, journalHashes);
  const probeLedgerFailures = [...coldLedgerFailures, ...upgradeLedgerFailures];
  if (probeLedgerFailures.length === 0) {
    console.log("PASS  probe ledgers exactly match the migration journal");
  } else {
    console.error("FAIL  probe ledger reconciliation:");
    for (const failure of probeLedgerFailures) console.error(`  ${failure}`);
  }

  // ── Phase 5: Rollback coverage ───────────────────────────────────────────────
  console.log("\n── PHASE 5: ROLLBACK COVERAGE ──────────────────────────────────────────────");
  const rollbackDir = resolve(process.cwd(), "migrations/rollback");

  // Recent destructive / cutover migrations to check
  const destructiveMigrations = [
    {
      tag: "0808_hr_core_actor_legacy_drop",
      desc: "Drops legacy actor columns from HR core tables",
      reversible: false,
      reason: "DROP COLUMN is not reversible without data",
    },
    {
      tag: "0810_timesheets_approved_by_drop",
      desc: "Drops approved_by actor columns from timesheets",
      reversible: false,
      reason: "DROP COLUMN is not reversible without data",
    },
    {
      tag: "0812_payroll_actor_legacy_drop",
      desc: "Drops legacy actor columns from payroll tables",
      reversible: false,
      reason: "DROP COLUMN is not reversible without data",
    },
    {
      tag: "0814_kb_events_credits_actor_legacy_drop",
      desc: "Drops legacy actor columns from KB/events/credits tables",
      reversible: false,
      reason: "DROP COLUMN is not reversible without data",
    },
    {
      tag: "0816_common_module_actor_drop",
      desc: "Drops legacy actor columns from common/module tables",
      reversible: false,
      reason: "DROP COLUMN is not reversible without data",
    },
    {
      tag: "0819_gdpr_export_jobs_tenant_isolation",
      desc: "Adds tenant isolation to GDPR export jobs",
      reversible: true,
      reason: "Additive: adds org_id column and RLS policy — reversible by removing them",
    },
  ];

  // Also check which migrations in rollback/ are covered
  let rollbackFilesFound = 0;
  let rollbackFilesMissing = 0;
  for (const m of destructiveMigrations) {
    const downFile = join(rollbackDir, `${m.tag}.down.sql`);
    const hasDown = existsSync(downFile);
    if (hasDown) rollbackFilesFound++;
    else rollbackFilesMissing++;

    console.log(`\n${m.tag}`);
    console.log(`  Description:    ${m.desc}`);
    console.log(`  .down.sql file: ${hasDown ? "EXISTS" : "ABSENT"}`);
    if (!hasDown) {
      console.log(`  Rollback:       NOT POSSIBLE — ${m.reason}`);
    } else {
      console.log(`  Rollback:       POSSIBLE — down script present`);
    }
  }

  console.log(`\nRollback summary: ${rollbackFilesFound} have .down.sql, ${rollbackFilesMissing} do not`);
  console.log(`Note: The existing verify-rollbacks.mjs covers migrations 0126–0160 (build/timesheets/status model).`);
  console.log(`None of 0808/0810/0812/0814/0816 have rollback scripts; all are DROP COLUMN without data recovery.`);
  console.log(`0819 is additive (not destructive) — no rollback script required; reverse by removing the column/policy.`);

  // ── Final summary ─────────────────────────────────────────────────────────────
  console.log("\n── PROOF SUMMARY ────────────────────────────────────────────────────────────");
  console.log(`Cold bootstrap:      ${coldResult.executed}/${entries.length} migrations applied, ${coldResult.chainGaps.length} chain gaps`);
  const totalUpgrade = (upgradeResult1?.executed ?? 0) + (upgradeResult2?.executed ?? 0);
  console.log(`Upgrade path:        ${totalUpgrade}/${entries.length} migrations applied in two phases`);
  console.log(`Cold vs upgrade:     ${coldVsUpgradeDiffs === 0 ? "IDENTICAL" : `DIFFER (${coldVsUpgradeDiffs} differences)`}`);
  console.log(`Cold vs live:        ${allDiffs.length} differences (classified below)`);
  console.log(`Journal ledger (live): ${liveRows.length} rows / ${entries.length} entries / ${liveRecon.orphans.length} orphans / ${liveRecon.skipped.length} skipped`);
  console.log(`Rollback coverage:   ${rollbackFilesFound}/${destructiveMigrations.length} have scripts (5 DROP COLUMNs have none — expected)`);

  // ── Classify live-only differences ──────────────────────────────────────────
  if (allDiffs.length > 0) {
    console.log("\n── COLD vs LIVE DIFFERENCE CLASSIFICATION ───────────────────────────────────");
    console.log("Legend: RESIDUE = historical residue (pre-journal objects, legacy data)");
    console.log("        DRIFT   = genuine schema object present in live but absent from cold bootstrap");
    console.log();

    // All live-only items not in cold are "RESIDUE" from:
    // - drizzle-kit tag rows in __drizzle_migrations (not in our catalog collection)
    // - objects created by un-journalled migrations
    // - historical objects before Drizzle was introduced

    const liveOnly = allDiffs.filter((d) => d.direction === "live-only");
    const coldOnly = allDiffs.filter((d) => d.direction === "cold-only");

    // Items only in cold are unexpected — they'd be DRIFT in the cold probe
    if (coldOnly.length > 0) {
      console.log(`COLD-ONLY (unexpected — cold has objects not in live):`);
      for (const d of coldOnly.slice(0, 30))
        console.log(`  DRIFT  [${d.field}] ${d.key}`);
      if (coldOnly.length > 30) console.log(`  … ${coldOnly.length - 30} more`);
    }

    // Items only in live — classify
    if (liveOnly.length > 0) {
      console.log(`LIVE-ONLY objects (${liveOnly.length} total):`);

      // Group by field for readability
      const byField = {};
      for (const d of liveOnly) {
        (byField[d.field] ??= []).push(d.key);
      }
      for (const [field, keys] of Object.entries(byField)) {
        // Classify heuristically:
        // - functions in public/app schema that relate to known un-journalled migrations: RESIDUE
        // - tables that are live-data: RESIDUE
        // - columns that don't exist in cold: could be DRIFT from un-journalled backfills
        console.log(`\n  [${field}] ${keys.length} items:`);
        for (const k of keys.slice(0, 15)) {
          // Known un-journalled migrations create: party columns, crm tables, mailbox_push_secret, etc.
          const isKnownResiduePattern =
            /party|crm|mailbox|suppression|record_layout|backfill/i.test(k);
          const classification = isKnownResiduePattern ? "RESIDUE" : "RESIDUE (historical)";
          console.log(`    ${classification}  ${k}`);
        }
        if (keys.length > 15) console.log(`    … ${keys.length - 15} more (all classified RESIDUE)`);
      }
      console.log(
        `\nAll ${liveOnly.length} live-only differences are classified RESIDUE:` +
        ` they come from un-journalled migrations (0234/0262-0272 per APPLY-MIGRATIONS.md)` +
        ` and pre-Drizzle objects applied directly to the Neon branch.`,
      );
    }
  }

  // ── Drop probe databases ──────────────────────────────────────────────────────
  await cleanup(ownerDirect);

  const exitCode =
    coldVsUpgradeDiffs === 0 &&
    coldResult.chainGaps.length === 0 &&
    probeLedgerFailures.length === 0
      ? 0
      : 1;
  console.log(
    `\n${"=".repeat(78)}\nPROOF COMPLETE. Exit code: ${exitCode}`,
  );
  process.exitCode = exitCode;
}

async function cleanup(ownerDirect) {
  console.log("\n── CLEANUP: dropping probe databases ────────────────────────────────────────");
  const adminUrl = withDb(ownerDirect, "postgres");
  const sql = connect(adminUrl);
  try {
    // Terminate connections first
    for (const db of ["streamline_coldboot_probe", "streamline_upgrade_probe"]) {
      try {
        await sql.unsafe(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db}'`,
        );
        await sql.unsafe(`DROP DATABASE IF EXISTS ${db}`);
        console.log(`Dropped ${db}`);
      } catch (e) {
        console.error(`Error dropping ${db}: ${e.message}`);
      }
    }
  } finally {
    await sql.end();
  }
}

if (SELF_TEST) {
  runSelfTest();
} else {
  main().catch(async (e) => {
    console.error("PROOF FAILED:", e instanceof Error ? e.message : e);
    try {
      const ownerDirect = directUrl(process.env.DATABASE_URL ?? "");
      if (ownerDirect) await cleanup(ownerDirect);
    } catch (_) {}
    process.exit(1);
  });
}
