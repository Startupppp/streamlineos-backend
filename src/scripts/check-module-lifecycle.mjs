import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import * as dotenv from "dotenv";
import { loadModuleManifest } from "./permission-key-extractors.mjs";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(SCRIPT_DIR, "../..");
const SCHEMA_ROOT = join(BACKEND_ROOT, "src", "db", "schema");
const MIGRATIONS_DIR = join(BACKEND_ROOT, "migrations");

dotenv.config({ path: join(BACKEND_ROOT, ".env") });

const args = process.argv.slice(2);
const MODULE_ID =
  args.find((a) => a.startsWith("--module="))?.slice("--module=".length) ?? "timesheets";

export function parseSchemaSource(src) {
  const tableMatches = [...src.matchAll(/pgTable\(\s*["']([^"']+)["']/g)];
  const result = [];
  for (let i = 0; i < tableMatches.length; i++) {
    const match = tableMatches[i];
    const tableName = match[1];
    const segStart = match.index;
    const segEnd =
      i + 1 < tableMatches.length ? tableMatches[i + 1].index : src.length;
    const segment = src.slice(segStart, segEnd);
    const indexNames = [
      ...segment.matchAll(/(?:uniqueIndex|index)\(\s*["']([^"']+)["']/g),
    ].map((m) => m[1]);
    result.push({ tableName, indexNames });
  }
  return result;
}

function scanSchemaFolder(schemaDir) {
  if (!existsSync(schemaDir)) return [];
  return readdirSync(schemaDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .flatMap((e) =>
      parseSchemaSource(readFileSync(join(schemaDir, e.name), "utf8")),
    );
}

function buildMigrationIndex(tables, migrationsDir) {
  const journal = JSON.parse(
    readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"),
  );
  const journaledTags = new Set(journal.entries.map((e) => e.tag));
  const remaining = new Set(tables.map((t) => t.tableName));
  const index = new Map();
  for (const file of readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    if (remaining.size === 0) break;
    const tag = file.replace(/\.sql$/, "");
    if (!journaledTags.has(tag)) continue;
    const content = readFileSync(join(migrationsDir, file), "utf8");
    for (const tableName of [...remaining]) {
      const re = new RegExp(
        `CREATE TABLE(?:\\s+IF NOT EXISTS)?\\s+(?:"[^"]*"\\.\\s*)?"${tableName}"[\\s(]`,
        "i",
      );
      if (re.test(content)) {
        index.set(tableName, tag);
        remaining.delete(tableName);
      }
    }
  }
  return index;
}

export function checkTenantIsolation(tables, policiedTables) {
  const missing = tables.filter((t) => !policiedTables.has(t.tableName));
  return { ok: missing.length === 0, missing };
}

export function checkColdMigration(tables, catalogTables, migrationIndex) {
  const missing = [];
  for (const t of tables) {
    if (!catalogTables.has(t.tableName)) {
      missing.push({ tableName: t.tableName, reason: "not in pg_catalog" });
      continue;
    }
    if (!migrationIndex.has(t.tableName))
      missing.push({
        tableName: t.tableName,
        reason: "no journaled migration creates it",
      });
  }
  return { ok: missing.length === 0, missing };
}

export function checkRestore(tables, catalogPks, catalogOrgFks, catalogIndexes) {
  const missing = [];
  for (const t of tables) {
    if (!catalogPks.has(t.tableName))
      missing.push({ tableName: t.tableName, reason: "no primary key in pg_catalog" });
    if (!catalogOrgFks.has(t.tableName))
      missing.push({ tableName: t.tableName, reason: "no org_id FK in pg_catalog" });
    const tableIdxs = catalogIndexes.get(t.tableName) ?? new Set();
    for (const idx of t.indexNames)
      if (!tableIdxs.has(idx))
        missing.push({ tableName: t.tableName, reason: `index "${idx}" absent from pg_catalog` });
  }
  return { ok: missing.length === 0, missing };
}

export function checkRemoval(tables, notNullOrgIds, orgIdFkTypes) {
  const missing = [];
  for (const t of tables) {
    if (!notNullOrgIds.has(t.tableName))
      missing.push({ tableName: t.tableName, reason: "org_id is nullable or missing" });
    if (!orgIdFkTypes.has(t.tableName))
      missing.push({ tableName: t.tableName, reason: "org_id has no FK on organizations" });
  }
  return { ok: missing.length === 0, missing };
}

if (args.includes("--self-test")) {
  const checks = {};

  const singleSrc = `export const t = pgTable("my_table", { id: text("id") }, (t) => [index("idx_my_table_id").on(t.id)]);`;
  const singleResult = parseSchemaSource(singleSrc);
  checks.singleTableFound = singleResult.length === 1 && singleResult[0].tableName === "my_table";
  checks.indexExtracted =
    singleResult[0]?.indexNames.length === 1 &&
    singleResult[0].indexNames[0] === "idx_my_table_id";

  const multilineSrc = `export const t = pgTable(\n  "table_a", { id: text("id") });\nexport const s = pgTable("table_b", { id: text("id") });`;
  const multiResult = parseSchemaSource(multilineSrc);
  checks.multilineTableNameFound = multiResult.some((t) => t.tableName === "table_a");
  checks.twoTablesInFile = multiResult.length === 2;

  checks.nonTableCallNotCaptured = parseSchemaSource(`const x = otherCall("not_a_table", {});\n`).length === 0;
  checks.emptySourceReturnsEmpty = parseSchemaSource("").length === 0;

  const uniqueIdxSrc = `export const t = pgTable("tbl", {}, (t) => [uniqueIndex("uniq_tbl_x").on(t.x)]);`;
  const uniqueResult = parseSchemaSource(uniqueIdxSrc);
  checks.uniqueIndexExtracted =
    uniqueResult[0]?.indexNames.length === 1 &&
    uniqueResult[0].indexNames[0] === "uniq_tbl_x";

  const goodTable = { tableName: "timesheets", indexNames: ["idx_ts_org"] };
  const allTables = [goodTable];

  const g1pass = checkTenantIsolation(allTables, new Set(["timesheets"]));
  const g1fail = checkTenantIsolation(allTables, new Set());
  checks.tenantIsolationPassesWhenPolicyExists = g1pass.ok;
  checks.tenantIsolationFailsOnMissingPolicy =
    !g1fail.ok && g1fail.missing.length === 1;

  const g2pass = checkColdMigration(
    allTables,
    new Set(["timesheets"]),
    new Map([["timesheets", "0000_tag"]]),
  );
  const g2failCatalog = checkColdMigration(allTables, new Set(), new Map());
  const g2failJournal = checkColdMigration(
    allTables,
    new Set(["timesheets"]),
    new Map(),
  );
  checks.coldMigrationPassesWhenBothPresent = g2pass.ok;
  checks.coldMigrationFailsWhenNotInCatalog = !g2failCatalog.ok;
  checks.coldMigrationFailsWhenNoJournaledMigration = !g2failJournal.ok;

  const g3pass = checkRestore(
    allTables,
    new Set(["timesheets"]),
    new Set(["timesheets"]),
    new Map([["timesheets", new Set(["idx_ts_org"])]]),
  );
  const g3failPk = checkRestore(
    allTables,
    new Set(),
    new Set(["timesheets"]),
    new Map([["timesheets", new Set(["idx_ts_org"])]]),
  );
  const g3failFk = checkRestore(
    allTables,
    new Set(["timesheets"]),
    new Set(),
    new Map([["timesheets", new Set(["idx_ts_org"])]]),
  );
  const g3failIdx = checkRestore(
    allTables,
    new Set(["timesheets"]),
    new Set(["timesheets"]),
    new Map([["timesheets", new Set()]]),
  );
  checks.restorePassesWhenAllPresent = g3pass.ok;
  checks.restoreFailsWhenNoPk = !g3failPk.ok;
  checks.restoreFailsWhenNoOrgFk = !g3failFk.ok;
  checks.restoreFailsWhenIndexMissing = !g3failIdx.ok;

  const g4pass = checkRemoval(
    allTables,
    new Set(["timesheets"]),
    new Map([["timesheets", "c"]]),
  );
  const g4failNull = checkRemoval(
    allTables,
    new Set(),
    new Map([["timesheets", "c"]]),
  );
  const g4failFk = checkRemoval(allTables, new Set(["timesheets"]), new Map());
  checks.removalPassesWhenNonNullableWithFk = g4pass.ok;
  checks.removalFailsWhenOrgIdNullable = !g4failNull.ok;
  checks.removalFailsWhenNoFk = !g4failFk.ok;

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(JSON.stringify({ selfTest: true, pass, checks }, null, 2) + "\n");
  process.exit(pass ? 0 : 1);
}

async function main() {
  let manifest;
  try {
    manifest = loadModuleManifest();
  } catch (err) {
    process.stderr.write(`Cannot load module manifest: ${err.message}\n`);
    process.exit(2);
  }

  const moduleEntry = manifest.modules.find((m) => m.id === MODULE_ID);
  if (!moduleEntry) {
    process.stderr.write(`Module "${MODULE_ID}" not found in manifest.\n`);
    process.exit(2);
  }

  if (!moduleEntry.schemaFolder) {
    process.stderr.write(
      `Module "${MODULE_ID}" declares no schemaFolder — nothing to check.\n`,
    );
    process.exit(0);
  }

  const schemaDir = join(SCHEMA_ROOT, moduleEntry.schemaFolder);
  const tables = scanSchemaFolder(schemaDir);

  if (tables.length === 0) {
    process.stderr.write(
      `HARD FAIL — schema scan of "${schemaDir}" discovered 0 tables.\n` +
        `A zero result means the pgTable() scan is broken, not that the module is empty.\n` +
        `Verify that the schemaFolder contains .ts files with pgTable("name", ...) declarations.\n`,
    );
    process.exit(1);
  }

  process.stdout.write(`Module: ${MODULE_ID}  (schemaFolder: ${moduleEntry.schemaFolder})\n`);
  process.stdout.write(`Tables discovered: ${tables.length}\n`);
  for (const t of tables)
    process.stdout.write(`  ${t.tableName}  (${t.indexNames.length} declared index(es))\n`);
  process.stdout.write("\n");

  const appUrl = process.env.APP_DATABASE_URL;
  if (!appUrl) {
    // Gates 1-4 ARE this check. Exiting 0 here made a run that measured nothing
    // indistinguishable from a run that verified the module, so a CI job reading
    // the exit code could not tell them apart. Match the convention the other
    // database-backed gates use: INCONCLUSIVE is exit 2, never OK.
    const allowPartial = process.env.STREAMLINE_ALLOW_PARTIAL_GATES === "1";
    process.stdout.write(
      `${allowPartial ? "PARTIAL" : "INCONCLUSIVE"} — APP_DATABASE_URL is not set.\n` +
        "Gates 1–4 require a non-owner connection to query pg_catalog as the app role.\n" +
        "The owner role has BYPASSRLS; connecting as it would hide tenant-isolation gaps.\n" +
        "Only the schema-side table/index discovery above ran; nothing about RLS,\n" +
        "grants, cold migration, restore or removal was verified.\n" +
        "Required variable: APP_DATABASE_URL\n" +
        "Example: APP_DATABASE_URL=postgres://streamline_app:<password>@<host>/neondb\n" +
        `Tables scanned: ${tables.length}  Module: ${MODULE_ID}\n`,
    );
    process.exit(allowPartial ? 0 : 2);
  }

  const sql = postgres(appUrl, { prepare: false, max: 1, onnotice: () => {} });
  let failures = 0;
  const check = (label, ok, detail) => {
    if (!ok) failures++;
    process.stdout.write(
      `${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}\n`,
    );
  };

  try {
    const tableNames = tables.map((t) => t.tableName);

    process.stdout.write("Gate 1: Tenant isolation (RLS policies in pg_policies)\n");
    const policyRows = await sql`
      SELECT DISTINCT tablename FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = ANY(${tableNames})
        AND (
          COALESCE(qual, '') ILIKE '%org_id%'
          OR COALESCE(with_check, '') ILIKE '%org_id%'
        )
    `;
    const policiedTables = new Set(policyRows.map((r) => r.tablename));
    const g1 = checkTenantIsolation(tables, policiedTables);
    for (const m of g1.missing)
      check(
        `RLS policy on ${m.tableName}`,
        false,
        "tenant table has no org_id-predicated RLS policy",
      );
    if (g1.ok) check(`All ${tables.length} tables have tenant-predicated RLS policies`, true);
    process.stdout.write("\n");

    process.stdout.write("Gate 2: Cold migration (tables in pg_catalog + journaled migration)\n");
    const catalogRows = await sql`
      SELECT relname FROM pg_class
      JOIN pg_namespace n ON n.oid = relnamespace
      WHERE n.nspname = 'public'
        AND relkind = 'r'
        AND relname = ANY(${tableNames})
    `;
    const catalogTables = new Set(catalogRows.map((r) => r.relname));
    const migrationIndex = buildMigrationIndex(tables, MIGRATIONS_DIR);
    const g2 = checkColdMigration(tables, catalogTables, migrationIndex);
    for (const m of g2.missing) check(`Cold migration: ${m.tableName}`, false, m.reason);
    if (g2.ok)
      check(
        `All ${tables.length} tables exist in pg_catalog with journaled migrations`,
        true,
      );
    process.stdout.write("\n");

    process.stdout.write(
      "Gate 3: Restore (declared PK, org_id FK, named indexes present in pg_catalog)\n",
    );
    const pkRows = await sql`
      SELECT c.relname AS tablename FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_constraint ct ON ct.conrelid = c.oid AND ct.contype = 'p'
      WHERE n.nspname = 'public'
        AND c.relname = ANY(${tableNames})
    `;
    const catalogPks = new Set(pkRows.map((r) => r.tablename));

    const fkRows = await sql`
      SELECT DISTINCT c.relname AS tablename FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_constraint ct ON ct.conrelid = c.oid AND ct.contype = 'f'
      JOIN pg_attribute a ON a.attrelid = c.oid
        AND a.attnum = ANY(ct.conkey)
        AND a.attname = 'org_id'
        AND NOT a.attisdropped
      WHERE n.nspname = 'public'
        AND c.relname = ANY(${tableNames})
    `;
    const catalogOrgFks = new Set(fkRows.map((r) => r.tablename));

    const idxRows = await sql`
      SELECT tablename, indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = ANY(${tableNames})
    `;
    const catalogIndexes = new Map();
    for (const r of idxRows) {
      if (!catalogIndexes.has(r.tablename)) catalogIndexes.set(r.tablename, new Set());
      catalogIndexes.get(r.tablename).add(r.indexname);
    }

    const g3 = checkRestore(tables, catalogPks, catalogOrgFks, catalogIndexes);
    for (const m of g3.missing) check(`Restore: ${m.tableName}`, false, m.reason);
    if (g3.ok) check(`All ${tables.length} tables pass restore check`, true);
    process.stdout.write("\n");

    process.stdout.write(
      "Gate 4: Removal (org_id NOT NULL with FK whose ON DELETE is defined)\n",
    );
    const notNullRows = await sql`
      SELECT c.relname AS tablename FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
        AND a.attname = 'org_id'
        AND NOT a.attisdropped
        AND a.attnotnull = true
      WHERE n.nspname = 'public'
        AND c.relname = ANY(${tableNames})
    `;
    const notNullOrgIds = new Set(notNullRows.map((r) => r.tablename));

    const fkTypeRows = await sql`
      SELECT DISTINCT c.relname AS tablename, ct.confdeltype FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_constraint ct ON ct.conrelid = c.oid AND ct.contype = 'f'
      JOIN pg_attribute a ON a.attrelid = c.oid
        AND a.attnum = ANY(ct.conkey)
        AND a.attname = 'org_id'
        AND NOT a.attisdropped
      WHERE n.nspname = 'public'
        AND c.relname = ANY(${tableNames})
    `;
    const orgIdFkTypes = new Map(fkTypeRows.map((r) => [r.tablename, r.confdeltype]));

    const g4 = checkRemoval(tables, notNullOrgIds, orgIdFkTypes);
    for (const m of g4.missing) check(`Removal: ${m.tableName}`, false, m.reason);
    if (g4.ok) {
      check(`All ${tables.length} tables have non-nullable org_id with FK`, true);
      const DELTYPE = { a: "NO ACTION", r: "RESTRICT", c: "CASCADE", n: "SET NULL", d: "SET DEFAULT" };
      for (const [tbl, type] of orgIdFkTypes)
        process.stdout.write(`  org_id ON DELETE ${DELTYPE[type] ?? type}  — ${tbl}\n`);
    }
  } finally {
    await sql.end();
  }

  process.stdout.write(
    `\nRESULT: ${failures === 0 ? "ALL GATES PASSED" : `${failures} CHECK(S) FAILED`}` +
      `  (${MODULE_ID}, ${tables.length} tables)\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`Unexpected error: ${err.message}\n${err.stack ?? ""}\n`);
  process.exit(1);
});
