#!/usr/bin/env node
/**
 * Gate: Date value interpolated directly into a raw drizzle sql`` template.
 *
 * THE BUG CLASS
 * -------------
 * A JS `Date` interpolated into a drizzle sql`` template reaches postgres.js where
 * a string is expected, and throws at runtime:
 *
 *   TypeError: The "string" argument must be of type string or an instance of
 *   Buffer or ArrayBuffer. Received an instance of Date  [ERR_INVALID_ARG_TYPE]
 *
 * The correct form is `${date.toISOString()}::timestamptz` (explicit cast),
 * or a column-aware Drizzle operator such as `lt(col, date)`.
 *
 * WHY IT KEEPS BEING MISSED
 * -------------------------
 * Three things hide it every time: `forEachOrg` logs a per-org failure and
 * continues, so the endpoint still returns 200 success; Drizzle only logs
 * "Failed query: <sql> params: <...>"; and the real cause sits on `error.cause`.
 * It has bitten at least twice:
 *
 *   2026-08-14: notification-delivery-worker, notification-outbox-relay, ai-jobs,
 *   payroll/run-lock — zero notifications were ever delivered while crons reported
 *   200 on every tick.
 *
 *   2026-09-05: all three retention sweeps (helpdesk, mail, announcements) had
 *   never deleted a single row across six organisations.
 *
 * WHAT THIS GATE CHECKS
 * ----------------------
 * For every sql`` tagged template literal in non-test TypeScript source files,
 * each `${expr}` is inspected:
 *
 *   DANGEROUS (flagged):
 *     ${new Date(...)}          — Date constructor, directly a Date
 *     ${name}                   — bare identifier typed as Date at the nearest
 *                                 preceding annotation in the file
 *
 *   SAFE (not flagged):
 *     ${date.toISOString()}     — explicit string conversion method
 *     ${table.column}           — property access, treated as a column reference
 *     ${lt(col, date)}          — function call, treated as a Drizzle operator
 *
 * PRECISION OVER RECALL
 * ---------------------
 * For bare identifiers, the gate uses the closest preceding `name: <type>`
 * annotation (not a file-wide name set). This means a variable shadowed by a
 * parameter with a non-Date type in the enclosing function is NOT flagged,
 * even if an earlier function in the same file uses the same name as Date.
 * This avoids false positives at the cost of missing some inferred-type cases.
 *
 * ANTI-VACUITY
 * ------------
 * If fewer than MIN_FILES source files are found, or fewer than MIN_SQL_TEMPLATES
 * sql`` occurrences are detected across them, the gate exits 2 (INCONCLUSIVE)
 * rather than reporting a false green.
 *
 * Usage:
 *   node src/scripts/check-date-in-sql-template.mjs
 *   node src/scripts/check-date-in-sql-template.mjs --self-test
 *
 * Exit codes:
 *   0 — no violations
 *   1 — violations found (or self-test failed)
 *   2 — scan measured nothing (scanner is broken)
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_TEST = process.argv.includes("--self-test");

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");

const SKIP_DIRS = ["node_modules", "dist", "__tests__", "migrations", "scripts"];

/** Floor for anti-vacuity: too few means the walk is broken. */
const MIN_FILES = 1000;

/** Floor for anti-vacuity: too few means the sql`` detector is broken. */
const MIN_SQL_TEMPLATES = 50;

// ---------------------------------------------------------------------------
// Core detection
// ---------------------------------------------------------------------------

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find the type annotation for `name` that appears closest before `pos` in
 * `source`. Looks for patterns like `name: Date`, `name?: Date | null`.
 *
 * By using the LAST occurrence before the interpolation rather than a file-wide
 * set, a parameter typed `string | null` in the enclosing function takes
 * precedence over an earlier function's `name: Date` parameter — avoiding the
 * false positive that name-set collection produces.
 *
 * Returns the type string (e.g. "Date", "Date | null", "string | null"), or
 * null when no annotation is found before pos.
 */
function closestTypeOf(source, name, pos) {
  const pattern =
    "\\b" +
    escapeRegExp(name) +
    "\\s*\\??\\s*:\\s*([\\w<>\\[\\]|&\\s]+?)(?=[,;)=>\\n\\r{])";
  const re = new RegExp(pattern, "g");
  let lastType = null;
  let m;
  while ((m = re.exec(source)) !== null) {
    if (m.index < pos) lastType = m[1].trim();
  }
  return lastType;
}

/**
 * Determines whether an interpolated expression inside a sql`` template is a
 * Date value that will crash the postgres.js driver.
 *
 * @param {string} expr  The trimmed expression text (what's between ${ and }).
 * @param {string} source  The full file source, for nearest-annotation lookup.
 * @param {number} pos  Byte position of the expression start in source.
 */
export function isDangerousDateExpr(expr, source, pos) {
  const t = expr.trim();

  // Safe: explicit string-conversion method call at the end of the expression.
  // Handles: cutoff.toISOString(), new Date().toISOString(), etc.
  if (
    /\.(toISOString|toLocaleDateString|toUTCString|toDateString|toTimeString|toString)\s*\(\s*\)\s*$/.test(
      t,
    )
  )
    return false;

  // Dangerous: Date constructor — always produces a Date instance.
  if (/^new\s+Date\s*\(/.test(t)) return true;

  // Safe: property access (a.b) — treated as a Drizzle column reference or
  // method chain.  This covers both `${schema.column}` and `${val.method()}`.
  if (t.includes(".")) return false;

  // Safe: function call — treated as a Drizzle column-aware operator.
  // This covers lt(col, date), eq(col, val), sql.raw(...), etc.
  if (/\w\s*\(/.test(t)) return false;

  // Bare identifier: look up the nearest preceding type annotation.
  if (/^[a-zA-Z_$][\w$]*$/.test(t)) {
    const type = closestTypeOf(source, t, pos);
    if (
      type &&
      /\bDate\b/.test(type) &&
      !/\bstring\b|\bnumber\b|\bboolean\b/.test(type)
    )
      return true;
  }

  return false;
}

/**
 * Scan `source` for sql`` template violations.
 *
 * The template body parser is a state machine that handles:
 *   - `\\` escape sequences
 *   - Nested string literals inside `${}` expressions (single and double quotes)
 *   - Nested template literals inside `${}` expressions (backtick-balanced)
 *
 * Returns an array of { line, text } violation objects where `line` is the
 * 1-based source line of the interpolation and `text` is the full `${expr}`
 * snippet.
 */
export function scanFile(source) {
  const violations = [];

  function lineOf(p) {
    return source.slice(0, p).split("\n").length;
  }

  const sqlTagRe = /\bsql`/g;
  let m;

  while ((m = sqlTagRe.exec(source)) !== null) {
    let pos = m.index + m[0].length; // position right after the opening backtick

    // Scan the template body until the closing backtick.
    while (pos < source.length) {
      const ch = source[pos];

      if (ch === "\\") {
        // Escaped character — skip two bytes.
        pos += 2;
        continue;
      }

      if (ch === "`") {
        // End of the sql`` template.
        pos++;
        break;
      }

      if (ch === "$" && pos + 1 < source.length && source[pos + 1] === "{") {
        // Start of a template interpolation.
        pos += 2; // skip the ${
        const exprStart = pos;

        // Balance braces to find the matching }.
        let depth = 1;
        while (pos < source.length && depth > 0) {
          const c = source[pos];
          if (c === "{") {
            depth++;
          } else if (c === "}") {
            depth--;
            if (depth === 0) break;
          } else if (c === '"' || c === "'") {
            // Skip string literal content so a } inside a string isn't counted.
            const q = c;
            pos++;
            while (pos < source.length) {
              if (source[pos] === "\\") pos++; // skip escape
              else if (source[pos] === q) break;
              pos++;
            }
          } else if (c === "`") {
            // Nested template literal — skip until the matching backtick.
            // Handles patterns like: sql.join(arr.map(r => sql`${r.id}`), sql`, `)
            pos++;
            let tDepth = 1;
            while (pos < source.length && tDepth > 0) {
              if (source[pos] === "`") tDepth--;
              else if (source[pos] === "$" && source[pos + 1] === "{") {
                tDepth++;
                pos++;
              } else if (source[pos] === "\\") {
                pos++;
              }
              pos++;
            }
            continue;
          }
          pos++;
        }

        const expr = source.slice(exprStart, pos).trim();
        if (isDangerousDateExpr(expr, source, exprStart)) {
          violations.push({ line: lineOf(exprStart), text: `\${${expr}}` });
        }

        pos++; // skip the closing }
      } else {
        pos++;
      }
    }

    // Resume the outer regex search from after this template.
    sqlTagRe.lastIndex = pos;
  }

  return violations;
}

/** Count sql`` template occurrences for anti-vacuity. */
export function countSqlTemplates(source) {
  return (source.match(/\bsql`/g) ?? []).length;
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

function collectFiles(dir) {
  const files = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.includes(entry)) continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) files.push(...collectFiles(full));
    else if (
      stat.isFile() &&
      extname(entry) === ".ts" &&
      !entry.endsWith(".spec.ts") &&
      !entry.endsWith(".d.ts")
    )
      files.push(full);
  }
  return files;
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

function runSelfTest() {
  let passed = 0;
  const failures = [];
  const assert = (label, cond) => {
    if (cond) passed++;
    else failures.push(label);
  };

  // --- isDangerousDateExpr unit tests ---

  // POSITIVE: Date constructor variants
  assert("flags new Date()", isDangerousDateExpr("new Date()", "", 0));
  assert("flags new Date(Date.now())", isDangerousDateExpr("new Date(Date.now())", "", 0));
  assert("flags new Date(ts)", isDangerousDateExpr("new Date(ts)", "", 0));

  // NEGATIVE: explicit string-conversion method (check before new Date rule)
  assert("allows new Date().toISOString()", !isDangerousDateExpr("new Date().toISOString()", "", 0));
  assert("allows cutoff.toISOString()", !isDangerousDateExpr("cutoff.toISOString()", "", 0));
  assert("allows d.toUTCString()", !isDangerousDateExpr("d.toUTCString()", "", 0));

  // NEGATIVE: property access treated as column reference
  assert("allows table.column", !isDangerousDateExpr("documents.createdAt", "", 0));
  assert("allows schema.col", !isDangerousDateExpr("announcements.id", "", 0));

  // NEGATIVE: Drizzle column-aware operators
  assert("allows lt(col, date)", !isDangerousDateExpr("lt(col, cutoff)", "", 0));
  assert("allows eq(col, val)", !isDangerousDateExpr("eq(documents.createdAt, cutoff)", "", 0));
  assert("allows lte(col, date)", !isDangerousDateExpr("lte(col, now)", "", 0));

  // NEGATIVE: bare identifier without Date annotation
  assert(
    "does not flag identifier with no annotation",
    !isDangerousDateExpr("orgId", "", 0),
  );
  assert(
    "does not flag identifier typed as string",
    !isDangerousDateExpr("orgId", "const orgId: string = '';", 100),
  );

  // POSITIVE: bare identifier with Date annotation
  const srcDateParam = "async function sweep(tx: TenantTx, orgId: string, cutoff: Date) {\n  const x = cutoff;\n";
  assert(
    "flags bare identifier typed as Date",
    isDangerousDateExpr("cutoff", srcDateParam, srcDateParam.length),
  );

  // POSITIVE: bare identifier with Date | null annotation
  const srcDateNullParam = "private f(cursor: { lma: Date | null; id: number } | null) {\n  const { lma } = cursor;\n";
  assert(
    "flags bare identifier typed as Date | null",
    isDangerousDateExpr("lma", srcDateNullParam, srcDateNullParam.length),
  );

  // NEGATIVE: closest annotation is non-Date (scope-shadowing case)
  // occurrenceStart: Date in an earlier function, but string | null in the enclosing one.
  const srcShadowed = [
    "private async earlier(orgId: string, occurrenceStart: Date): Promise<void> {",
    "  // earlier function",
    "}",
    "private async later(orgId: string, occurrenceStart: string | null): Promise<boolean> {",
    "  const x = occurrenceStart;",
  ].join("\n");
  assert(
    "does not flag when closest annotation is string | null, even if earlier function uses Date",
    !isDangerousDateExpr("occurrenceStart", srcShadowed, srcShadowed.length),
  );

  // --- scanFile integration tests ---

  // POSITIVE 1: sql`` with bare Date-typed parameter
  const src1 = [
    'import { sql } from "drizzle-orm";',
    "async function sweep(tx: any, orgId: string, cutoff: Date) {",
    "  await tx.delete(table).where(",
    "    sql`AND created_at < ${cutoff}`",
    "  );",
    "}",
  ].join("\n");
  assert("POSITIVE: sql`` with bare Date identifier is flagged", scanFile(src1).length === 1);

  // POSITIVE 2: sql`` with new Date()
  const src2 = "await tx.delete(t).where(sql`AND x < ${new Date()}`);";
  assert("POSITIVE: sql`` with new Date() is flagged", scanFile(src2).length === 1);

  // POSITIVE: multi-line sql`` template with bare Date identifier
  const src3 = [
    "async function sweep(tx: any, orgId: string, cutoff: Date) {",
    "  await tx.delete(helpdeskTickets).where(",
    "    sql`${helpdeskTickets.id} IN (",
    "      SELECT id FROM helpdesk_tickets",
    "      WHERE org_id = ${orgId}",
    "        AND resolved_at < ${cutoff}",
    "      LIMIT 200",
    "    )`",
    "  );",
    "}",
  ].join("\n");
  assert("POSITIVE: multi-line sql`` with bare Date identifier flagged", scanFile(src3).length === 1);

  // NEGATIVE 1: sql`` with toISOString()
  const src4 = [
    "async function sweep(tx: any, orgId: string, cutoff: Date) {",
    "  await tx.delete(t).where(",
    "    sql`AND created_at < ${cutoff.toISOString()}::timestamptz`",
    "  );",
    "}",
  ].join("\n");
  assert("NEGATIVE: toISOString() is not flagged", scanFile(src4).length === 0);

  // NEGATIVE 2: column-aware lt() outside sql`` — no template at all
  const src5 = "const res = await db.select().from(t).where(lt(documents.createdAt, cutoff));";
  assert("NEGATIVE: column-aware lt() is not flagged (no sql``)", scanFile(src5).length === 0);

  // NEGATIVE 3: column reference plus safe value in sql`` template
  const src6 = [
    "async function f(cutoff: Date) {",
    "  sql`AND ${documents.createdAt} < ${cutoff.toISOString()}::timestamptz`;",
    "}",
  ].join("\n");
  assert("NEGATIVE: column ref plus safe value not flagged", scanFile(src6).length === 0);

  // NEGATIVE 4: no sql`` template in the file
  const src7 = 'const x = "no sql template here"; const y = x.trim();';
  assert("NEGATIVE: file with no sql`` template not flagged", scanFile(src7).length === 0);

  // NEGATIVE 5: fixed multi-line template with toISOString()
  const src8 = [
    "async function sweep(tx: any, orgId: string, cutoff: Date) {",
    "  await tx.delete(helpdeskTickets).where(",
    "    sql`${helpdeskTickets.id} IN (",
    "      SELECT id FROM helpdesk_tickets",
    "      WHERE org_id = ${orgId}",
    "        AND resolved_at < ${cutoff.toISOString()}::timestamptz",
    "      LIMIT 200",
    "    )`",
    "  );",
    "}",
  ].join("\n");
  assert("NEGATIVE: fixed multi-line template not flagged", scanFile(src8).length === 0);

  // NEGATIVE 6: scope-shadowing — string | null shadows the Date annotation
  const src9 = [
    "private async resolveTarget(orgId: string, occurrenceStart: Date): Promise<void> {",
    "  // uses occurrenceStart as Date",
    "}",
    "private async hasNewer(",
    "  orgId: string,",
    "  occurrenceStart: string | null,",
    "): Promise<boolean> {",
    "  const sameTarget = occurrenceStart",
    "    ? sql`${queue.payload} ->> 'start' = ${occurrenceStart}`",
    "    : sql`${queue.payload} ->> 'start' is null`;",
    "}",
  ].join("\n");
  assert(
    "NEGATIVE: scope-shadowed identifier with non-Date nearest annotation not flagged",
    scanFile(src9).length === 0,
  );

  // --- Anti-vacuity: countSqlTemplates ---
  assert("countSqlTemplates finds sql`` occurrences", countSqlTemplates("const x = sql`WHERE 1=1`;") === 1);
  assert("countSqlTemplates returns 0 for no templates", countSqlTemplates("const x = 1;") === 0);
  assert(
    "countSqlTemplates counts multiple",
    countSqlTemplates("sql`a` + sql`b` + sql`c`") === 3,
  );

  if (failures.length > 0) {
    for (const f of failures) console.error(`  FAIL: ${f}`);
    console.error(
      `check-date-in-sql-template self-tests: ${failures.length} failed, ${passed} passed`,
    );
    process.exit(1);
  }
  console.log(`check-date-in-sql-template self-tests: ${passed} passed`);
  process.exit(0);
}

if (SELF_TEST) runSelfTest();

// ---------------------------------------------------------------------------
// Main scan
// ---------------------------------------------------------------------------

const files = collectFiles(ROOT);

if (files.length < MIN_FILES) {
  console.error(
    `INCONCLUSIVE: scanned ${files.length} files (floor ${MIN_FILES}) — too few to be a real scan`,
  );
  process.exit(2);
}

const violations = [];
let totalSqlTemplates = 0;

for (const file of files) {
  let src;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    continue;
  }

  const sqlCount = countSqlTemplates(src);
  totalSqlTemplates += sqlCount;
  if (sqlCount === 0) continue;

  for (const v of scanFile(src)) {
    violations.push({
      file: file.replace(/\\/g, "/").replace(ROOT.replace(/\\/g, "/") + "/", ""),
      ...v,
    });
  }
}

console.log(
  `Scanned ${files.length} TypeScript files — found ${totalSqlTemplates} sql\` template occurrence(s)`,
);

if (totalSqlTemplates < MIN_SQL_TEMPLATES) {
  console.error(
    `INCONCLUSIVE: found ${totalSqlTemplates} sql\` templates (floor ${MIN_SQL_TEMPLATES}) — the sql\` detector may be broken`,
  );
  process.exit(2);
}

if (violations.length > 0) {
  console.error(
    `\nFAIL — ${violations.length} Date value(s) interpolated directly into sql\`\` template(s):`,
  );
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.text}`);
  console.error(
    "\nFix: replace \${date} with \${date.toISOString()}::timestamptz (for timestamp columns)",
  );
  console.error(
    "     or use a column-aware Drizzle operator: lt(col, date), lte(col, date), gte(col, date), eq(col, date)",
  );
  process.exit(1);
}

console.log(
  `\ncheck:date-in-sql PASSED — no Date values interpolated into raw sql\`\` templates`,
);
process.exit(0);
