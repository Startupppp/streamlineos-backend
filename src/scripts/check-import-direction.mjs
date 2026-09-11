#!/usr/bin/env node
/**
 * Import-direction gate: shared code must never import feature code.
 *
 * Root CLAUDE.md §9 requires one-directional flow — features → shared, never
 * shared → features. A `src/common/**` file importing `src/modules/**` drags a
 * feature module into every importer of the shared one and is how an import
 * cycle is born.
 *
 * Nine such imports predate this gate. They are listed in BASELINE with the
 * symbol each one needs and the module that must relocate it. The gate fails on
 * anything not in that list, so the debt cannot grow. BASELINE may shrink; it
 * must never be extended.
 *
 * Flags:
 *   --self-test   Feed known-bad fixtures through the parser and exit.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

function resolvePath(rel) {
  return fileURLToPath(new URL(rel, import.meta.url));
}

const SRC = resolvePath("../");
const COMMON = join(SRC, "common");
const MIN_FILES = 50;

/** path → why it still exists and who must move the symbol. */
const BASELINE = {};

/**
 * Matches every ES import/re-export form, including `import type`, side-effect
 * `import "x";`, multi-line specifier lists and `export * from`. A gate that
 * only matched `import { X } from "y"` would miss the forms most likely to
 * carry the dependency it exists to find.
 */
const SPECIFIER = /(?:^|\n)\s*(?:import|export)\s(?:[\s\S]*?\sfrom\s)?\s*["']([^"']+)["']/g;

export function importedSpecifiers(source) {
  const found = [];
  for (const match of source.matchAll(SPECIFIER)) if (match[1]) found.push(match[1]);
  return found;
}

export function isFeatureImport(fromFileRelative, specifier) {
  if (specifier.startsWith("src/modules/")) return true;
  if (!specifier.startsWith(".")) return false;
  const dir = fromFileRelative.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") dir.pop();
    else dir.push(part);
  }
  return dir.join("/").startsWith("src/modules/");
}

function collectFiles(dir, files = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) collectFiles(full, files);
    else if (
      stat.isFile() &&
      extname(entry) === ".ts" &&
      !entry.endsWith(".d.ts") &&
      !entry.endsWith(".spec.ts") &&
      !entry.endsWith(".e2e-spec.ts")
    )
      files.push(full);
  }
  return files;
}

function runSelfTests() {
  let passed = 0;
  let failed = 0;
  const assert = (label, condition) => {
    if (condition) passed++;
    else {
      console.error(`  FAIL: ${label}`);
      failed++;
    }
  };

  const from = "src/common/auth/thing.ts";

  assert(
    "single-line relative import into modules is a violation",
    importedSpecifiers(`import { A } from "../../modules/access/a.service";`).some((s) =>
      isFeatureImport(from, s),
    ),
  );
  assert(
    "import type is a violation — erasing the runtime import does not erase the dependency direction",
    importedSpecifiers(`import type { A } from "../../modules/access/a.types";`).some((s) =>
      isFeatureImport(from, s),
    ),
  );
  assert(
    "multi-line specifier list is a violation",
    importedSpecifiers(`import {\n  a,\n  b,\n} from "../../modules/hr/x";`).some((s) =>
      isFeatureImport(from, s),
    ),
  );
  assert(
    "side-effect import with no specifier list is a violation",
    importedSpecifiers(`import "../../modules/access/register";`).some((s) =>
      isFeatureImport(from, s),
    ),
  );
  assert(
    "re-export is a violation — it republishes the feature symbol from shared",
    importedSpecifiers(`export * from "../../modules/rbac/permissions";`).some((s) =>
      isFeatureImport(from, s),
    ),
  );
  assert(
    "absolute src/modules alias is a violation",
    importedSpecifiers(`import { A } from "src/modules/access/a.service";`).some((s) =>
      isFeatureImport(from, s),
    ),
  );
  assert(
    "a sibling import inside common is not a violation",
    !importedSpecifiers(`import { A } from "../rbac/org-roles";`).some((s) =>
      isFeatureImport(from, s),
    ),
  );
  assert(
    "a package import is not a violation",
    !importedSpecifiers(`import { Module } from "@nestjs/common";`).some((s) =>
      isFeatureImport(from, s),
    ),
  );
  assert(
    "a path merely containing the word modules is not a violation",
    !importedSpecifiers(`import { A } from "../org/provision-org-modules";`).some((s) =>
      isFeatureImport(from, s),
    ),
  );
  assert(
    "BASELINE entries all carry an owner when present",
    Object.values(BASELINE).every((v) => /owner:/i.test(v)),
  );
  assert(
    "BASELINE entries all name a common file",
    Object.keys(BASELINE).every((p) => p.startsWith("src/common/")),
  );

  if (failed > 0) {
    console.error(`check-import-direction self-tests: ${failed} failed, ${passed} passed`);
    process.exit(1);
  }
  console.log(`check-import-direction self-tests: ${passed} passed`);
  process.exit(0);
}

if (process.argv.includes("--self-test")) runSelfTests();

const files = collectFiles(COMMON);

if (files.length < MIN_FILES) {
  console.error(
    `check-import-direction: vacuity guard — only ${files.length} files found under ${COMMON} (expected >= ${MIN_FILES}); the scan is broken`,
  );
  process.exit(1);
}

const violations = [];
const baselineSeen = new Set();

for (const file of files) {
  const rel = relative(resolvePath("../../"), file).replace(/\\/g, "/");
  const source = readFileSync(file, "utf8");
  for (const specifier of importedSpecifiers(source)) {
    if (!isFeatureImport(rel, specifier)) continue;
    if (Object.hasOwn(BASELINE, rel)) {
      baselineSeen.add(rel);
      continue;
    }
    violations.push({ file: rel, specifier });
  }
}

const stale = Object.keys(BASELINE).filter((p) => !baselineSeen.has(p));

console.log(
  `check-import-direction: scanned ${files.length} files under src/common — ${violations.length} new violation(s), ${baselineSeen.size} of ${Object.keys(BASELINE).length} baseline entries still present`,
);

if (stale.length > 0) {
  console.error(`\nBASELINE entries that no longer violate — remove them so the ratchet tightens:`);
  for (const p of stale) console.error(`  ${p}`);
}

if (violations.length > 0) {
  console.error(`\nShared code must not import feature code (root CLAUDE.md §9):`);
  for (const v of violations) console.error(`  ${v.file}\n    imports ${v.specifier}`);
  console.error(
    `\nTo fix: move the shared symbol into src/common/ and import it from both sides. Never extend BASELINE.`,
  );
}

process.exit(violations.length > 0 || stale.length > 0 ? 1 : 0);
