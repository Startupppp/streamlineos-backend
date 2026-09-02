#!/usr/bin/env node
/**
 * Gate: a Drizzle query may not reference a table it never puts in FROM/JOIN.
 *
 * TypeScript accepts `eq(a.col, otherTable.id)` regardless of whether
 * `otherTable` is in the query.  The generated SQL then either names a table
 * with no FROM entry (42P01) or, in a relational `db.query.x.findFirst`, is
 * silently rewritten onto the root alias and reads a column that does not
 * exist (42703).  Three live instances of this were found in build/core; all
 * passed tsc, madge, knip and their unit tests, because specs mock the db and
 * never render SQL.
 *
 * Detection:
 *   Form A  builder chains — `.select(...)` … `.from(X)` `.innerJoin(Y, …)`.
 *           In-scope = tables named in from/join. Any other schema-imported
 *           table referenced in the chain is a violation.
 *   Form B  relational — `db.query.<table>.findFirst|findMany({ where: … })`.
 *           In-scope = <table> plus any table named under `with:`.
 *
 * Precision: only identifiers imported from a db/schema module count; text
 * inside sql`` templates is ignored (raw SQL brings its own FROM); specs are
 * skipped. Chains containing a subquery/CTE construct are skipped and counted
 * out loud rather than guessed at.
 *
 * Usage:
 *   node src/scripts/check-unjoined-table-refs.mjs
 *   node src/scripts/check-unjoined-table-refs.mjs --self-test
 * Exit: 0 clean · 1 violations · 2 vacuous scan
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_TEST = process.argv.includes("--self-test");
const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const SRC_DIR = join(SCRIPT_DIR, "..");
const BACKEND_ROOT = join(SCRIPT_DIR, "../..");

const MIN_FILES = 200;
const MIN_CHAINS = 200;

const SKIP_CONSTRUCTS = [".as(", "$with", "unionAll(", "union(", "with(", "$dynamic("];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...walk(full));
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".spec.ts") &&
      !entry.name.endsWith(".e2e-spec.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Identifiers imported from a db/schema module in this file. */
export function schemaImports(source) {
  const names = new Set();
  const importRe = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  let match;
  while ((match = importRe.exec(source)) !== null) {
    const from = match[2];
    if (!/db\/schema/.test(from)) continue;
    for (const raw of match[1].split(",")) {
      const name = raw.replace(/\btype\b/, "").split(/\sas\s/).pop().trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/** Blank out sql`` template contents so raw SQL never counts as a reference. */
export function stripSqlTemplates(source) {
  return source.replace(/\bsql(?:\.raw)?(?:\s*<[^>`]*>)?`(?:[^`\\]|\\.)*`/gs, "sql``");
}

/** Blank comments so a comment between two joins cannot truncate a chain walk. */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, prefix) => prefix + " ".repeat(match.length - prefix.length));
}

function balancedSlice(source, start) {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    } else if (depth === 0 && (ch === ";" || ch === "\n")) {
      const rest = source.slice(i).trimStart();
      if (!rest.startsWith(".")) return source.slice(start, i);
    }
  }
  return source.slice(start);
}

/**
 * Walk a method chain from `.select(` forward, consuming `(...)` groups and
 * `.name` segments, stopping at the first token that does not continue the
 * chain. Stopping only at `;` would swallow sibling queries inside a
 * `Promise.all([...])` and merge their tables into one scope.
 */
function chainFrom(source, index) {
  let i = index;
  const end = source.length;
  while (i < end) {
    while (i < end && /\s/.test(source[i])) i++;
    if (source[i] !== ".") break;
    i++;
    while (i < end && /[\w$]/.test(source[i])) i++;
    while (i < end && /\s/.test(source[i])) i++;
    if (source[i] !== "(") continue;
    let depth = 0;
    while (i < end) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
      i++;
    }
  }
  return source.slice(index, i);
}

function tablesIn(text, known) {
  const found = new Set();
  const re = /\b([A-Za-z_$][\w$]*)\s*\./g;
  let m;
  while ((m = re.exec(text)) !== null) if (known.has(m[1])) found.add(m[1]);
  return found;
}

function scopeTables(chain, known) {
  const found = new Set();
  const re = /\.(?:from|innerJoin|leftJoin|rightJoin|fullJoin)\s*\(\s*([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(chain)) !== null) if (known.has(m[1])) found.add(m[1]);
  return found;
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

const CORRELATING_COMBINATORS = new Set(["exists", "notExists", "inArray", "notInArray"]);

/**
 * True when the chain is a fragment rather than a standalone query: either the
 * RHS of an assignment, or the argument of a combinator that embeds a
 * correlated subquery. Both may legitimately reference an enclosing query's
 * tables, which cannot be resolved from the fragment alone.
 */
export function isBoundToName(source, selectIndex) {
  let i = selectIndex - 1;
  while (i >= 0 && /\s/.test(source[i])) i--;
  while (i >= 0 && /[\w$.]/.test(source[i])) i--;
  while (i >= 0 && /\s/.test(source[i])) i--;
  if (i < 0) return false;
  if (source[i] === "=" && source[i - 1] !== "=" && source[i - 1] !== "!") return true;
  if (source[i] !== "(") return false;
  let j = i - 1;
  while (j >= 0 && /\s/.test(source[j])) j--;
  let end = j + 1;
  while (j >= 0 && /[\w$]/.test(source[j])) j--;
  return CORRELATING_COMBINATORS.has(source.slice(j + 1, end));
}

export function scanSource(source, known) {
  const violations = [];
  let skipped = 0;
  const text = stripSqlTemplates(stripComments(source));

  const selectRe = /\.select\s*\(/g;
  let m;
  const chains = [];
  while ((m = selectRe.exec(text)) !== null) {
    const chain = chainFrom(text, m.index);
    if (!/\.from\s*\(/.test(chain)) continue;
    chains.push({ start: m.index, end: m.index + chain.length, chain });
  }

  for (const entry of chains) {
    if (SKIP_CONSTRUCTS.some((c) => entry.chain.includes(c))) {
      skipped++;
      continue;
    }
    // A chain bound to a name is a fragment that some later query embeds — it
    // may legitimately correlate to that query's tables, which is unresolvable
    // from the fragment alone.
    if (isBoundToName(text, entry.start)) {
      skipped++;
      continue;
    }
    const inScope = scopeTables(entry.chain, known);
    if (inScope.size === 0) continue;
    // A correlated subquery may reference any table of an enclosing query.
    for (const outer of chains) {
      if (outer === entry) continue;
      if (outer.start < entry.start && outer.end >= entry.end)
        for (const table of scopeTables(outer.chain, known)) inScope.add(table);
    }
    for (const table of tablesIn(entry.chain, known)) {
      if (!inScope.has(table))
        violations.push({ line: lineOf(text, entry.start), table, form: "builder" });
    }
  }

  const relRe = /\bquery\s*\.\s*([A-Za-z_$][\w$]*)\s*\.\s*(?:findFirst|findMany)\s*\(/g;
  while ((m = relRe.exec(text)) !== null) {
    const args = balancedSlice(text, m.index + m[0].length - 1);
    if (SKIP_CONSTRUCTS.some((c) => args.includes(c))) {
      skipped++;
      continue;
    }
    // A `with:` clause pulls in related tables under relation keys that need not
    // match the table identifier, so its scope cannot be resolved statically.
    if (/\bwith\s*:\s*\{/.test(args)) {
      skipped++;
      continue;
    }
    const inScope = new Set([m[1]]);
    for (const table of tablesIn(args, known)) {
      if (!inScope.has(table))
        violations.push({ line: lineOf(text, m.index), table, form: "relational" });
    }
  }

  return { violations, skipped };
}

if (SELF_TEST) {
  const known = new Set([
    "projectMembers",
    "organizationMembers",
    "projectTeamAssignments",
    "projectTeamMembers",
  ]);
  const header = `import { projectMembers, organizationMembers, projectTeamAssignments, projectTeamMembers } from "../db/schema";\n`;

  const brokenTeamJoin = `${header}
    const r = await db.select({ id: projectTeamMembers.id })
      .from(projectTeamAssignments)
      .innerJoin(projectTeamMembers, eq(projectTeamMembers.teamId, projectTeamAssignments.teamId))
      .where(and(eq(projectTeamAssignments.projectId, id), eq(projectTeamMembers.membershipId, organizationMembers.id)))
      .limit(1);`;

  const brokenBareSelect = `${header}
    const r = await db.select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .where(and(eq(projectMembers.orgId, orgId), eq(projectMembers.membershipId, organizationMembers.id), eq(organizationMembers.userId, userId)));`;

  const brokenRelational = `${header}
    const member = await db.query.projectMembers.findFirst({
      where: and(eq(projectMembers.projectId, id), eq(projectMembers.membershipId, organizationMembers.id), eq(organizationMembers.userId, uid)),
      columns: { id: true },
    });`;

  const fixedJoin = `${header}
    const r = await db.select({ id: projectTeamMembers.id })
      .from(projectTeamAssignments)
      .innerJoin(projectTeamMembers, eq(projectTeamMembers.teamId, projectTeamAssignments.teamId))
      .innerJoin(organizationMembers, eq(organizationMembers.id, projectTeamMembers.membershipId))
      .where(eq(projectTeamAssignments.projectId, id))
      .limit(1);`;

  const fixedRelational = `${header}
    const member = await db.query.projectMembers.findFirst({
      where: and(eq(projectMembers.projectId, id), eq(projectMembers.orgId, orgId)),
      columns: { id: true },
    });`;

  const rawSqlIsIgnored = `${header}
    const r = await db.select({ id: projectMembers.id })
      .from(projectMembers)
      .where(sql\`EXISTS (SELECT 1 FROM organization_members om WHERE om.id = \${projectMembers.membershipId})\`);`;

  const checks = {
    flagsBrokenTeamJoin: scanSource(brokenTeamJoin, known).violations.length === 1,
    flagsBrokenBareSelect: scanSource(brokenBareSelect, known).violations.length > 0,
    flagsBrokenRelational: scanSource(brokenRelational, known).violations.length > 0,
    passesFixedJoin: scanSource(fixedJoin, known).violations.length === 0,
    passesFixedRelational: scanSource(fixedRelational, known).violations.length === 0,
    ignoresRawSqlTemplate: scanSource(rawSqlIsIgnored, known).violations.length === 0,
    importParserFindsSchemaNames: schemaImports(header).has("projectMembers"),
    importParserIgnoresNonSchema:
      !schemaImports(`import { foo } from "@nestjs/common";\n`).has("foo"),
  };

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(JSON.stringify({ selfTest: true, pass, checks }, null, 2) + "\n");
  process.exit(pass ? 0 : 1);
}

const files = walk(join(SRC_DIR, "modules")).concat(walk(join(SRC_DIR, "common")));
if (files.length < MIN_FILES) {
  console.error(`ERROR: scan found only ${files.length} files — the walk is broken`);
  process.exit(2);
}

let chains = 0;
let skipped = 0;
const findings = [];
for (const file of files) {
  const source = readFileSync(file, "utf8");
  const known = schemaImports(source);
  if (known.size === 0) continue;
  chains += (source.match(/\.select\s*\(|\bquery\s*\.\s*\w+\s*\.\s*find/g) ?? []).length;
  const result = scanSource(source, known);
  skipped += result.skipped;
  for (const v of result.violations)
    findings.push({ file: relative(BACKEND_ROOT, file).replace(/\\/g, "/"), ...v });
}

if (chains < MIN_CHAINS) {
  console.error(`ERROR: only ${chains} queries seen — the scan is vacuous`);
  process.exit(2);
}

console.log(
  `check:unjoined-table-refs — ${files.length} files, ${chains} queries, ${skipped} skipped (subquery/CTE construct)`,
);

if (findings.length === 0) {
  console.log("OK — every referenced table is in its query's FROM/JOIN.");
  process.exit(0);
}

console.error(`FAIL — ${findings.length} unjoined table reference(s):`);
for (const f of findings)
  console.error(`  ${f.file}:${f.line}  ${f.table} referenced but never joined (${f.form})`);
console.error("");
console.error("Fix: add the table to the query with .innerJoin(table, <condition>),");
console.error("or bind the value directly instead of dereferencing another table's column.");
process.exit(1);
