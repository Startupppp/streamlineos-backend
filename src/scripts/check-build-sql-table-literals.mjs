#!/usr/bin/env node
/**
 * check-build-sql-table-literals.mjs
 *
 * Every `build.<identifier>` and `build_events.<identifier>` literal that
 * appears inside a `sql\`...\`` template in `src/modules/build/**` must name a
 * real table in the Drizzle schema (`src/db/schema/build/**`).
 *
 * The Drizzle index and tenancy gates scan table objects, not string literals,
 * so any drift between a hardcoded literal and the live schema is silent until
 * the query reaches the database.
 *
 * Cannot see:
 *   - table names constructed by string concatenation or variable interpolation
 *   - literals inside non-`sql` template literals (e.g. raw query strings)
 *   - literals inside single- or double-quoted strings
 *   - literals inside block or line comments
 *   - references in migration files (not scanned)
 *
 * Usage:
 *   node src/scripts/check-build-sql-table-literals.mjs [--self-test] [--list]
 *
 * Exit codes:
 *   0 — all literals name known tables
 *   1 — one or more literals do not name a known table (or self-test failed)
 *   2 — the scan resolved nothing (gate is vacuous)
 */

import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const SELF_TEST = process.argv.includes("--self-test");
const LIST = process.argv.includes("--list");

const BACKEND_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const BUILD_SRC = join(BACKEND_ROOT, "src/modules/build");
const BUILD_SCHEMA = join(BACKEND_ROOT, "src/db/schema/build");

const MIN_SOURCE_FILES = 30;
const MIN_SCHEMA_TABLES = 50;

function walk(dir, out, re) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out, re);
    else if (re.test(entry)) out.push(full);
  }
  return out;
}

function stripCrlf(text) {
  return text.replace(/\r/g, "");
}

function extractSchemaTableNames(schemaDir) {
  const tables = { build: new Set(), build_events: new Set() };
  const files = walk(schemaDir, [], /\.ts$/);
  for (const f of files) {
    const text = stripCrlf(readFileSync(f, "utf8"));
    const re = /(build|buildEvents)\.table\(\s*["']([a-z_]+)["']/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const ns = m[1] === "buildEvents" ? "build_events" : "build";
      tables[ns].add(m[2]);
    }
  }
  return tables;
}

function extractSqlBody(text, start) {
  let i = start;
  let exprDepth = 0;
  const chars = [];
  while (i < text.length) {
    if (text[i] === "\\") { i += 2; continue; }
    if (text[i] === "$" && text[i + 1] === "{") {
      exprDepth++;
      chars.push(" ");
      i += 2;
      continue;
    }
    if (exprDepth > 0) {
      if (text[i] === "{") exprDepth++;
      else if (text[i] === "}") exprDepth--;
      i++;
      continue;
    }
    if (text[i] === "`") return { body: chars.join(""), end: i };
    chars.push(text[i]);
    i++;
  }
  return { body: chars.join(""), end: i };
}

export function extractBuildTableRefs(fileText) {
  const text = stripCrlf(fileText);
  const refs = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (text[i] === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length - 1 && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (text[i] === '"') {
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (text[i] === "'") {
      i++;
      while (i < text.length && text[i] !== "'") {
        if (text[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (text.slice(i, i + 4) === "sql`") {
      const { body, end } = extractSqlBody(text, i + 4);
      const refRe = /\b(build_events|build)\.([a-z_]+)/g;
      let m;
      while ((m = refRe.exec(body)) !== null) {
        const line = text.slice(0, i + 4 + m.index).split("\n").length;
        refs.push({ schema: m[1], table: m[2], line });
      }
      i = end + 1;
      continue;
    }
    if (text[i] === "`") {
      i++;
      let depth = 0;
      while (i < text.length) {
        if (text[i] === "\\") { i += 2; continue; }
        if (text[i] === "$" && text[i + 1] === "{") { depth++; i += 2; continue; }
        if (depth > 0) {
          if (text[i] === "{") depth++;
          else if (text[i] === "}") depth--;
          i++;
          continue;
        }
        if (text[i] === "`") { i++; break; }
        i++;
      }
      continue;
    }
    i++;
  }
  return refs;
}

function runSelfTest() {
  let failures = 0;
  let assertions = 0;
  const assert = (label, cond) => {
    assertions++;
    if (!cond) { console.error(`  FAIL: ${label}`); failures++; }
    else { console.log(`  ok:   ${label}`); }
  };

  const knownGood = `
    import { sql } from "drizzle-orm";
    const q = sql\`SELECT id FROM build.tickets WHERE org_id = \${orgId}\`;
  `;
  const goodRefs = extractBuildTableRefs(knownGood);
  assert(
    "extracts build.tickets from a sql template with a ${} interpolation",
    goodRefs.length === 1 && goodRefs[0].schema === "build" && goodRefs[0].table === "tickets",
  );

  const knownBad = `
    import { sql } from "drizzle-orm";
    const q = sql\`SELECT id FROM build.nonexistent_table WHERE org_id = \${orgId}\`;
  `;
  const badRefs = extractBuildTableRefs(knownBad);
  assert(
    "extracts build.nonexistent_table from a sql template",
    badRefs.length === 1 && badRefs[0].table === "nonexistent_table",
  );

  const eventsRef = `
    const q = sql\`INSERT INTO build_events.ticket_activity_log (org_id) VALUES (\${x})\`;
  `;
  const eventsRefs = extractBuildTableRefs(eventsRef);
  assert(
    "extracts build_events.ticket_activity_log from a sql template",
    eventsRefs.length === 1 && eventsRefs[0].schema === "build_events" && eventsRefs[0].table === "ticket_activity_log",
  );

  const outsideSql = `
    const s = "SELECT * FROM build.tickets";
    const msg = \`plain template build.tickets\`;
    const x = 'build.tickets';
  `;
  const outsideRefs = extractBuildTableRefs(outsideSql);
  assert(
    "does NOT extract build.tickets from a string literal, plain template, or single-quoted string",
    outsideRefs.length === 0,
  );

  const multiRef = `
    const q = sql\`
      SELECT t.id
      FROM build.tickets t
      LEFT JOIN build.project_statuses ps ON ps.org_id = t.org_id
      WHERE t.org_id = \${orgId}
    \`;
  `;
  const multiRefs = extractBuildTableRefs(multiRef);
  assert(
    "extracts both build.tickets and build.project_statuses from a multiline sql template",
    multiRefs.length === 2 &&
    multiRefs.some((r) => r.table === "tickets") &&
    multiRefs.some((r) => r.table === "project_statuses"),
  );

  const inComment = `
    // build.tickets is cool
    /* build.tickets also */
    const q = sql\`SELECT 1\`;
  `;
  const commentRefs = extractBuildTableRefs(inComment);
  assert(
    "does NOT extract build.tickets from line or block comments",
    commentRefs.length === 0,
  );

  const tmpSchemaDir = join(tmpdir(), "check-build-sql-table-literals-self-test-schema");
  if (existsSync(tmpSchemaDir)) rmSync(tmpSchemaDir, { recursive: true });
  mkdirSync(tmpSchemaDir, { recursive: true });
  writeFileSync(
    join(tmpSchemaDir, "fake-schema.ts"),
    `
    export const tickets = build.table("tickets", { id: integer("id") });
    export const projectStatuses = build.table(
      "project_statuses",
      { id: integer("id") }
    );
    export const activityLog = buildEvents.table(
      "ticket_activity_log",
      { id: integer("id") }
    );
    `,
  );
  const schemaTables = extractSchemaTableNames(tmpSchemaDir);
  rmSync(tmpSchemaDir, { recursive: true });

  assert(
    "extractSchemaTableNames finds build.tickets from a schema file",
    schemaTables.build.has("tickets"),
  );
  assert(
    "extractSchemaTableNames finds build.project_statuses from a multiline declaration",
    schemaTables.build.has("project_statuses"),
  );
  assert(
    "extractSchemaTableNames finds build_events.ticket_activity_log from a buildEvents declaration",
    schemaTables.build_events.has("ticket_activity_log"),
  );

  assert(
    "a known-bad table name (nonexistent_table) is NOT in the extracted schema tables (gate would catch it)",
    !schemaTables.build.has("nonexistent_table"),
  );

  if (failures > 0) {
    console.error(`\ncheck-build-sql-table-literals self-test: ${failures}/${assertions} FAILED`);
    process.exit(1);
  }
  console.log(`\ncheck-build-sql-table-literals self-tests: ${assertions}/${assertions} passed`);
  process.exit(0);
}

if (SELF_TEST) runSelfTest();

const schemaTables = extractSchemaTableNames(BUILD_SCHEMA);
const totalKnown = schemaTables.build.size + schemaTables.build_events.size;

if (totalKnown < MIN_SCHEMA_TABLES) {
  console.error(
    `INCONCLUSIVE — only ${totalKnown} tables found in schema (floor ${MIN_SCHEMA_TABLES}). Schema walk is broken.`,
  );
  process.exit(2);
}

const sourceFiles = walk(BUILD_SRC, [], /\.ts$/);

if (sourceFiles.length < MIN_SOURCE_FILES) {
  console.error(
    `INCONCLUSIVE — only ${sourceFiles.length} source files found under modules/build (floor ${MIN_SOURCE_FILES}). Walk is broken.`,
  );
  process.exit(2);
}

const breaches = [];
const allRefs = [];

for (const f of sourceFiles) {
  const text = readFileSync(f, "utf8");
  const refs = extractBuildTableRefs(text);
  for (const ref of refs) {
    const knownSet = ref.schema === "build_events" ? schemaTables.build_events : schemaTables.build;
    const known = knownSet.has(ref.table);
    allRefs.push({ file: relative(BACKEND_ROOT, f), line: ref.line, schema: ref.schema, table: ref.table, known });
    if (!known) {
      breaches.push({ file: relative(BACKEND_ROOT, f), line: ref.line, ref: `${ref.schema}.${ref.table}` });
    }
  }
}

console.log(`Scanned ${sourceFiles.length} source files under src/modules/build  ·  ${allRefs.length} build.*/build_events.* literal(s) found  ·  ${breaches.length} unknown`);
console.log(
  `\nCannot see: table names constructed by string concatenation or variable interpolation; literals outside sql\`\` templates (strings, plain templates, comments); references in migration files.`,
);

if (LIST || breaches.length > 0) {
  const printRefs = breaches.length > 0 ? breaches.map((b) => ({ ...b, status: "UNKNOWN" })) : allRefs.map((r) => ({ file: r.file, line: r.line, ref: `${r.schema}.${r.table}`, status: r.known ? "ok" : "UNKNOWN" }));
  for (const r of printRefs) {
    console.log(`  ${r.status === "UNKNOWN" ? "UNKNOWN" : "ok    "}  ${r.file}:${r.line}  ${r.ref}`);
  }
}

if (breaches.length > 0) {
  console.error(
    `\nFAIL — ${breaches.length} build.*/build_events.* literal(s) inside sql templates do not name a real table in src/db/schema/build/**. Each is a silent drift that will fail at query time.`,
  );
  process.exit(1);
}

console.log(`\nOK — all ${allRefs.length} sql template table literal(s) name known build schema tables.`);
