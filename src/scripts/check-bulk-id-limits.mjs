#!/usr/bin/env node
/**
 * Gate: every z.array(...) property whose name is `ids` or ends in `Ids`
 * inside src/**\/*.schemas.ts must have a .max() call in its chain.
 *
 * An unbounded ids-array is a denial-of-service and read-amplification
 * vector: one request can force an arbitrarily large IN (...) or an
 * arbitrarily large write transaction.
 *
 * Detection strategy
 * ------------------
 * Schema properties are often written across multiple lines, e.g.:
 *
 *   memberIds: z
 *     .array(z.string())
 *     .optional(),
 *
 * A single-line regex misses these. This script collapses all whitespace
 * (including newlines) to a single space before scanning, then uses a
 * depth-aware parser to extract each property value and checks for both
 * z.array() and .max() within that value.
 *
 * Excluded paths: src/modules/crm/** and src/modules/inventory/**
 *
 * --self-test   run built-in fixtures and exit; proves the scanner is not
 *               vacuous and that multi-line declarations are detected.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const SRC_ROOT = new URL("../", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

const EXCLUDED_MODULE_DIRS = new Set(["crm", "inventory"]);

/**
 * Explicitly allowlisted properties that must NOT be capped.
 * Each entry must carry a reason. The gate will not flag these.
 *
 * Currently empty: every property in scope has been given a safe cap.
 */
const ALLOWLIST = [
  // Example shape (do not remove):
  // { file: "example.schemas.ts", prop: "someIds",
  //   reason: "fans out to entire org; truncation silently drops recipients" }
];

// ─── file discovery ─────────────────────────────────────────────────────────

function isExcludedPath(fullPath) {
  const normalized = fullPath.replace(/\\/g, "/");
  for (const seg of EXCLUDED_MODULE_DIRS) {
    if (normalized.includes(`/modules/${seg}/`)) return true;
  }
  return false;
}

function collectSchemaFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      results.push(...collectSchemaFiles(full));
    } else if (stat.isFile() && entry.endsWith(".schemas.ts")) {
      if (!isExcludedPath(full)) results.push(full);
    }
  }
  return results;
}

// ─── scanner ─────────────────────────────────────────────────────────────────

/**
 * Extract the property value starting at `start` in `flat`, stopping at the
 * first comma or closing bracket at depth 0. Depth is tracked across all
 * bracket types: ( [ {.
 */
function extractPropertyValue(flat, start) {
  let depth = 0;
  let i = start;
  while (i < flat.length) {
    const c = flat[i];
    if (c === "(" || c === "[" || c === "{") {
      depth++;
    } else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth--;
    } else if (c === "," && depth === 0) {
      break;
    } else if (c === ";" && depth === 0) {
      break;
    }
    i++;
  }
  return flat.slice(start, i);
}

/**
 * Scan `content` (the text of a schema file) for id-array properties that
 * lack a .max() call. Returns an array of violation objects.
 */
function scanContent(filePath, content) {
  // Collapse all whitespace (including newlines) to a single space so that
  // multi-line property declarations become one continuous string.
  const flat = content.replace(/\s+/g, " ");

  const violations = [];

  // Property names to detect:
  //   - exactly `ids`  (e.g. audience.ids)
  //   - anything ending in `Ids`  (e.g. memberIds, attendeeIds, leadIds)
  // We also allow an optional `?` before the `:` (optional properties in
  // discriminated unions / intersection types).
  const propRe = /\b((?:\w+I|i)ds)\s*\??\s*:/g;

  let m;
  while ((m = propRe.exec(flat)) !== null) {
    const propName = m[1];
    const valueStart = m.index + m[0].length;
    const value = extractPropertyValue(flat, valueStart);

    // Only flag properties whose value is a z.array(...) chain.
    if (!/z\s*\.array\s*\(/.test(value)) continue;

    // The chain must include .max( somewhere.
    if (/\.max\s*\(/.test(value)) continue;

    // Check allowlist.
    const fileName = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
    if (ALLOWLIST.some((a) => a.file === fileName && a.prop === propName)) continue;

    violations.push({
      file: filePath,
      prop: propName,
      snippet: value.trim().slice(0, 140),
    });
  }

  return violations;
}

// ─── self-test ───────────────────────────────────────────────────────────────

function runSelfTest() {
  console.log("Running self-test…");
  let allPassed = true;

  function assert(label, condition) {
    if (condition) {
      console.log(`  PASS  ${label}`);
    } else {
      console.error(`  FAIL  ${label}`);
      allPassed = false;
    }
  }

  // ── Fixture 1: multi-line unbounded declaration ──────────────────────────
  // This is the exact form that defeated a prior single-line regex gate.
  const multiLineUnbounded = `
export const createTestRunSchema = z.object({
  name: z.string().min(1).max(500),
  caseIds: z
    .array(z.number().int().positive())
    .optional(),
  suiteId: z.number().int().positive().optional(),
});
`;
  const multiLineFindings = scanContent("<fixture:multi-line>", multiLineUnbounded);
  assert(
    "multi-line unbounded declaration detected (not missed by whitespace collapse)",
    multiLineFindings.length === 1 && multiLineFindings[0].prop === "caseIds",
  );

  // ── Fixture 2: single-line unbounded declaration ─────────────────────────
  const singleLineUnbounded = `
export const bulkSchema = z.object({
  leadIds: z.array(z.number()).min(1),
  tagIds: z.array(z.string()),
});
`;
  const singleLineFindings = scanContent("<fixture:single-line>", singleLineUnbounded);
  assert(
    "single-line unbounded declaration detected (leadIds)",
    singleLineFindings.some((f) => f.prop === "leadIds"),
  );
  assert(
    "single-line unbounded declaration detected (tagIds)",
    singleLineFindings.some((f) => f.prop === "tagIds"),
  );

  // ── Fixture 3: bounded declarations must NOT be flagged ──────────────────
  // This proves the scanner is not vacuous: good declarations pass.
  const bounded = `
export const goodSchema = z.object({
  memberIds: z.array(z.string()).max(100).optional(),
  attendeeIds: z.array(z.string()).min(1).max(200),
  runEmployeeIds: z.array(z.number().int().positive()).max(100).optional(),
  choiceIds: z.array(z.number().int().positive()).max(50).optional(),
});
`;
  const boundedFindings = scanContent("<fixture:bounded>", bounded);
  assert(
    "bounded declarations are not flagged (scanner is not vacuous)",
    boundedFindings.length === 0,
  );

  // ── Fixture 4: non-array ids properties must not be flagged ─────────────
  const nonArray = `
export const filterSchema = z.object({
  assigneeId: z.string().optional(),
  projectIds: csvToIntArray,
});
`;
  const nonArrayFindings = scanContent("<fixture:non-array>", nonArray);
  assert(
    "non-z.array ids properties are not flagged (projectIds from csvToIntArray)",
    nonArrayFindings.length === 0,
  );

  // ── Fixture 5: multi-line bounded declaration must NOT be flagged ────────
  const multiLineBounded = `
export const otherSchema = z.object({
  memberIds: z
    .array(z.string())
    .max(100)
    .optional(),
});
`;
  const multiLineBoundedFindings = scanContent("<fixture:multi-line-bounded>", multiLineBounded);
  assert(
    "multi-line bounded declaration not flagged",
    multiLineBoundedFindings.length === 0,
  );

  if (!allPassed) {
    console.error("\nSelf-test FAILED.");
    process.exit(1);
  }
  console.log("\nAll self-tests passed.");
}

// ─── main ────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  if (args.includes("--self-test")) {
    runSelfTest();
    return;
  }

  const files = collectSchemaFiles(SRC_ROOT);

  if (files.length < 50) {
    console.error(
      `ERROR: only ${files.length} schema files found under ${SRC_ROOT} — ` +
        "scan appears incomplete; check SRC_ROOT.",
    );
    process.exit(1);
  }

  const allViolations = [];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    allViolations.push(...scanContent(file, content));
  }

  if (allViolations.length === 0) {
    console.log(
      `check:bulk-id-limits — scanned ${files.length} schema files; ` +
        "no unbounded id-array properties found.",
    );
    process.exit(0);
  }

  console.error(
    `\ncheck:bulk-id-limits — FOUND ${allViolations.length} UNBOUNDED ID-ARRAY PROPERT${allViolations.length === 1 ? "Y" : "IES"}:\n`,
  );
  for (const v of allViolations) {
    const rel = v.file.replace(/\\/g, "/").replace(SRC_ROOT.replace(/\\/g, "/"), "");
    console.error(`  ${rel}`);
    console.error(`    property : ${v.prop}`);
    console.error(`    value    : ${v.snippet}`);
    console.error();
  }
  console.error(
    "Add .max(<N>) to each array chain above. See backend/CLAUDE.md §4 " +
      "(resource consumption) for guidance on choosing N.",
  );
  process.exit(1);
}

main();
