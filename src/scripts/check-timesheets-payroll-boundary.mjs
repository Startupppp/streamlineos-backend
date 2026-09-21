/**
 * check-timesheets-payroll-boundary.mjs
 *
 * Timesheets feeds payroll; it does not depend on it.
 *
 * The rule exists because the two modules have different owners, and because
 * the violation is invisible: an `import { something } from "../payroll/..."`
 * compiles, passes every test, and reverses the dependency direction the
 * handoff port was built to establish. By the time anyone notices, the port is
 * decoration.
 *
 * Two directories are easy to confuse and this check must not:
 *
 *   src/modules/payroll/**            <- the payroll MODULE. Off limits.
 *   src/modules/timesheets/payroll/** <- timesheets' own export code. Fine.
 *
 * So specifiers are resolved against the importing file rather than matched as
 * strings; `./payroll-calc` inside timesheets is not a violation and a naive
 * substring check would call it one.
 *
 * Usage:
 *   node src/scripts/check-timesheets-payroll-boundary.mjs
 *   node src/scripts/check-timesheets-payroll-boundary.mjs --self-test
 *
 * Exit codes:
 *   0 — timesheets imports nothing from the payroll or hr modules
 *   1 — it does
 *   2 — vacuity guard (too few files scanned, or the fixtures moved)
 *   3 — self-test failure
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(__dirname, "../..");
const TIMESHEETS = join(BACKEND_ROOT, "src", "modules", "timesheets");

/** Module directories timesheets may not import from, and why. */
const FORBIDDEN = [
  {
    dir: join(BACKEND_ROOT, "src", "modules", "payroll"),
    label: "modules/payroll",
    why: "timesheets feeds payroll through TimesheetPayrollHandoffPort and outbox events; the dependency must not reverse",
  },
  {
    dir: join(BACKEND_ROOT, "src", "modules", "hr"),
    label: "modules/hr",
    why: "HRMS is read-only to this pack; consume it through a port or the shared schema, not by importing its services",
  },
];

/**
 * A scan floor. Timesheets has dozens of files, so a walk that returns a
 * handful means the module moved and this check is guarding nothing.
 */
const MINIMUM_FILES = 40;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      walk(full, out);
      continue;
    }
    if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Every import/export specifier in a TypeScript source. */
export function specifiers(source) {
  const found = [];
  const re = /\b(?:import|export)\b[\s\S]{0,400}?\sfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(re)) {
    const spec = match[1] ?? match[2];
    if (spec) found.push({ spec, index: match.index ?? 0 });
  }
  return found;
}

/**
 * Whether a specifier, resolved from `fromFile`, lands inside `dir`.
 *
 * Relative specifiers are resolved; bare ones are matched on their path shape.
 * Containment is decided by `relative()` rather than a prefix compare, because
 * `resolve()` yields "\" on Windows and a hardcoded `dir + "/"` matched nothing
 * there — the relative-escape rule was inert on every developer machine while
 * passing on CI. `relative()` returning "" means the same path; a result that
 * neither starts with ".." nor is absolute means the target is underneath. That
 * also keeps `.../payroll` from matching `.../payroll-something`, which the
 * trailing separator was there to prevent.
 */
export function resolvesInto(spec, fromFile, dir) {
  if (spec.startsWith(".")) {
    const target = resolve(dirname(fromFile), spec);
    const rel = relative(dir, target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  }
  const normalized = spec.replace(/\\/g, "/");
  const tail = dir.replace(/\\/g, "/").split("/src/")[1];
  return tail ? normalized.includes(`src/${tail}/`) || normalized.startsWith(`${tail}/`) : false;
}

function main() {
  const files = walk(TIMESHEETS);
  if (files.length < MINIMUM_FILES) {
    process.stdout.write(
      `VACUITY GUARD — walked ${files.length} file(s) under src/modules/timesheets, expected at ` +
        `least ${MINIMUM_FILES}. The module moved and this check is guarding nothing.\n`,
    );
    process.exit(2);
  }

  const violations = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const { spec, index } of specifiers(source)) {
      for (const rule of FORBIDDEN) {
        if (!resolvesInto(spec, file, rule.dir)) continue;
        violations.push({
          file: relative(BACKEND_ROOT, file).replace(/\\/g, "/"),
          line: source.slice(0, index).split("\n").length,
          spec,
          label: rule.label,
          why: rule.why,
        });
      }
    }
  }

  process.stdout.write(`Scanned ${files.length} file(s) under src/modules/timesheets.\n\n`);

  if (violations.length > 0) {
    process.stdout.write(`FAIL — ${violations.length} import(s) cross the boundary:\n`);
    for (const v of violations)
      process.stdout.write(`  ${v.file}:${v.line}  imports "${v.spec}" from ${v.label}\n      ${v.why}\n`);
    process.exit(1);
  }

  process.stdout.write(
    `PASS — timesheets imports nothing from ${FORBIDDEN.map((f) => f.label).join(" or ")}.\n`,
  );
}

function selfTest() {
  const here = join(TIMESHEETS, "payroll", "payroll-export.service.ts");
  const payroll = join(BACKEND_ROOT, "src", "modules", "payroll");
  const checks = {
    // The confusable pair: timesheets' own payroll folder is not the module.
    ownPayrollFolderIsFine: !resolvesInto("./lib/payroll-calc", here, payroll),
    siblingIsFine: !resolvesInto("../core/entries.service", here, payroll),
    // The real violation, by relative path out of timesheets.
    catchesRelativeEscape: resolvesInto("../../payroll/runs/payroll-run.service", here, payroll),
    // And by a path-shaped specifier.
    catchesPathShaped: resolvesInto("src/modules/payroll/runs/x", here, payroll),
    // A prefix that merely starts the same must not match.
    doesNotMatchPrefix: !resolvesInto("../../payroll-adjacent/x", here, payroll),
    findsImports: specifiers('import { a } from "./b";\nexport { c } from "../d";').length === 2,
    findsDynamicImports: specifiers('const x = await import("./lazy");').length === 1,
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok);
  process.stdout.write(`${JSON.stringify({ selfTest: true, checks }, null, 2)}\n`);
  if (failed.length > 0) process.exit(3);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
