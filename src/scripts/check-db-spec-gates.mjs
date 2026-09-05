/**
 * check-db-spec-gates.mjs
 *
 * Gate: a real-database spec must be reachable by a run this repository can
 * actually perform.
 *
 * Nine `*.db.spec.ts` files opened with
 *
 *   const ENABLED = process.env.INV_DB_TESTS === "1";
 *   const describeDb = ENABLED ? describe : describe.skip;
 *
 * and `INV_DB_TESTS` was set in no workflow, no package script, no `.env.example`
 * and no `.env.gates`. So every one of them was `describe.skip` in every run,
 * and reported as a silent green inside `pnpm test`. Four PRD criteria rested on
 * suites that had never executed a statement. Running them for the first time
 * found four defects, one of which — a projection rebuild that could not parse —
 * threw on every call for every organisation.
 *
 * So this asserts three things:
 *
 *   1. Every `src/**\/*.db.spec.ts` takes its suite from `src/test/db-spec-gate`
 *      (`dbSpecSuite`), which runs on the presence of a connection string and
 *      skips loudly by name when it is absent — or is a NAMED exemption with a
 *      reason, which this prints on every run rather than hiding in source.
 *   2. No spec is gated on an environment variable that nothing in the
 *      repository sets. That is the original defect, stated directly.
 *   3. `pnpm test:db` exists and at least one workflow runs it, so the tier has
 *      somewhere to run that is not a developer's laptop.
 *
 * Usage:
 *   node src/scripts/check-db-spec-gates.mjs [--self-test]
 * Exit:
 *   0   clean (or self-test passed)
 *   1   violations found or self-test failure
 *   2   vacuity check failed (the walk found fewer specs than exist)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(SCRIPT_DIR, "../..");

const SELF_TEST = process.argv.includes("--self-test");

/**
 * A floor, not a count. `check:inventory-*` taught the lesson: a walk that
 * silently matches nothing reports a clean pass, and the number that made it
 * clean is the number nobody looks at.
 */
const MIN_DB_SPECS = 12;

const GATE_MODULE = "db-spec-gate";
const GATE_CALL = "dbSpecSuite";

/**
 * Specs that still gate on their own variable, why, and what it would take.
 *
 * Printed on every run. An exemption that only exists in source is the thing
 * this gate was written to stop.
 *
 * Empty, and the empty is the point. The five CRM specs listed here until now
 * were exempt because they needed a seeded CRM tenant rather than merely a
 * migrated database. `src/test/db-spec-crm-fixture.ts` supplies one — the real
 * `PermissionCatalogSyncService` and the real `seedSystemRolesForOrg`, so the
 * RBAC probe measures the seeder rather than the fixture — and all five now
 * take their suite from `db-spec-gate` like the rest of the tier.
 */
const EXEMPT = [];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".db.spec.ts")) out.push(full);
  }
  return out;
}

/** Every place a variable could plausibly be set for a run. */
function collectSetVariables(root) {
  const found = new Set();
  const texts = [];

  const workflows = join(root, ".github", "workflows");
  if (existsSync(workflows))
    for (const f of readdirSync(workflows))
      texts.push(readFileSync(join(workflows, f), "utf8"));

  for (const name of ["package.json", ".env.example", ".env.gates"]) {
    const path = join(root, name);
    if (existsSync(path)) texts.push(readFileSync(path, "utf8"));
  }

  for (const text of texts)
    for (const m of text.matchAll(/\b([A-Z][A-Z0-9_]{2,})\s*[:=]/g)) found.add(m[1]);

  return found;
}

function gatingVariables(source) {
  const names = new Set();
  const gate = /process\.env\.([A-Z][A-Z0-9_]*)[^\n]*\?[^\n]*describe[^\n]*describe\.skip/g;
  for (const m of source.matchAll(gate)) names.add(m[1]);
  const twoLine =
    /const\s+\w+\s*=\s*process\.env\.([A-Z][A-Z0-9_]*)[^\n]*\n[^\n]*\?\s*describe\s*:\s*describe\.skip/g;
  for (const m of source.matchAll(twoLine)) names.add(m[1]);
  const viaConst = /const\s+(\w+)\s*=\s*process\.env\.([A-Z][A-Z0-9_]*)/g;
  for (const m of source.matchAll(viaConst))
    if (new RegExp(`${m[1]}\\s*\\?\\s*describe\\s*:\\s*describe\\.skip`).test(source))
      names.add(m[2]);
  return names;
}

function runChecks(root, { skipVacuity = false } = {}) {
  const srcDir = join(root, "src");
  const specs = existsSync(srcDir) ? walk(srcDir).sort() : [];
  const violations = [];

  if (!skipVacuity && specs.length < MIN_DB_SPECS) {
    process.stderr.write(
      `ERROR (vacuity): found only ${specs.length} *.db.spec.ts files — expected at least ` +
        `${MIN_DB_SPECS}. The walk is broken. Refusing to report a false clean pass.\n`,
    );
    process.exit(2);
  }

  const setVariables = collectSetVariables(root);
  const exemptFiles = new Map(EXEMPT.map((e) => [e.file, e]));

  for (const spec of specs) {
    const rel = relative(root, spec).split("\\").join("/");
    const source = readFileSync(spec, "utf8");
    const exemption = exemptFiles.get(rel);
    const gatedOn = [...gatingVariables(source)];

    if (exemption) {
      if (!gatedOn.includes(exemption.variable))
        violations.push({
          file: rel,
          msg:
            `is exempt for ${exemption.variable} but no longer gates on it — delete the exemption ` +
            `in check-db-spec-gates.mjs, an exemption nobody re-reads is the defect this gate exists for`,
        });
      continue;
    }

    for (const variable of gatedOn) {
      if (setVariables.has(variable)) continue;
      violations.push({
        file: rel,
        msg:
          `gates its suite on process.env.${variable}, which no workflow, package script, ` +
          `.env.example or .env.gates sets — the suite is describe.skip in every run this ` +
          `repository can perform, and reports as a silent green`,
      });
    }

    if (gatedOn.length === 0 && !source.includes(GATE_MODULE))
      violations.push({
        file: rel,
        msg:
          `does not take its suite from src/test/${GATE_MODULE} (${GATE_CALL}) — a real-database ` +
          `spec must run on the presence of a connection string and skip loudly by name without one`,
      });
  }

  const pkgPath = join(root, "package.json");
  const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, "utf8")) : { scripts: {} };
  if (!pkg.scripts?.["test:db"])
    violations.push({
      file: "package.json",
      msg: "has no test:db script — the tier needs one command that runs every *.db.spec.ts",
    });

  const workflowDir = join(root, ".github", "workflows");
  const workflowRuns =
    existsSync(workflowDir) &&
    readdirSync(workflowDir).some((f) =>
      readFileSync(join(workflowDir, f), "utf8").includes("test:db"),
    );
  if (!workflowRuns)
    violations.push({
      file: ".github/workflows",
      msg: "no workflow runs pnpm test:db — a tier with nowhere to run is the original defect",
    });

  return { specs, violations };
}

function report(root) {
  const { specs, violations } = runChecks(root);

  console.log(`check:db-spec-gates`);
  console.log(`  ${specs.length} *.db.spec.ts files scanned`);
  console.log(`  ${specs.length - EXEMPT.length} default-on via src/test/${GATE_MODULE}`);
  if (EXEMPT.length === 0) {
    console.log(`  0 exempt — every real-database spec runs on a connection string`);
  } else {
    console.log(`  ${EXEMPT.length} exempt, each named below with its reason:`);
    for (const e of EXEMPT) console.log(`    - ${e.file} (${e.variable}): ${e.reason}`);
  }

  if (violations.length > 0) {
    console.log("");
    for (const v of violations) console.log(`  VIOLATION ${v.file}: ${v.msg}`);
    console.log(`\ncheck:db-spec-gates FAILED (${violations.length})`);
    process.exit(1);
  }
  console.log("\ncheck:db-spec-gates PASSED");
}

function selfTest() {
  console.log("check-db-spec-gates self-test");
  console.log("=============================");
  let passed = 0;
  let failed = 0;
  const tmp = join(tmpdir(), `db-spec-gates-selftest-${process.pid}`);

  function fixture(specSource) {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(join(tmp, "src", "modules", "x"), { recursive: true });
    mkdirSync(join(tmp, ".github", "workflows"), { recursive: true });
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ scripts: { "test:db": "jest" } }),
    );
    writeFileSync(join(tmp, ".github", "workflows", "ci.yml"), "run: pnpm test:db\n");
    writeFileSync(join(tmp, "src", "modules", "x", "a.db.spec.ts"), specSource);
  }

  function expect(label, condition) {
    if (condition) {
      passed++;
      console.log(`  ok   ${label}`);
    } else {
      failed++;
      console.log(`  FAIL ${label}`);
    }
  }

  const compliant = `import { dbSpecSuite } from "../../test/db-spec-gate";\nconst d = dbSpecSuite();\nd("x", () => {});\n`;
  fixture(compliant);
  expect(
    "a compliant spec produces no violation",
    runChecks(tmp, { skipVacuity: true }).violations.length === 0,
  );

  fixture(
    `const ENABLED = process.env.NEVER_SET_ANYWHERE === "1";\nconst d = ENABLED ? describe : describe.skip;\nd("x", () => {});\n`,
  );
  expect(
    "a spec gated on an unset variable is a violation",
    runChecks(tmp, { skipVacuity: true }).violations.some((v) =>
      v.msg.includes("NEVER_SET_ANYWHERE"),
    ),
  );

  fixture(`describe("x", () => {});\n`);
  expect(
    "a spec that uses neither the shared gate nor a variable is a violation",
    runChecks(tmp, { skipVacuity: true }).violations.some((v) => v.msg.includes(GATE_MODULE)),
  );

  fixture(compliant);
  rmSync(join(tmp, ".github", "workflows", "ci.yml"));
  expect(
    "no workflow running test:db is a violation",
    runChecks(tmp, { skipVacuity: true }).violations.some((v) => v.msg.includes("test:db")),
  );

  fixture(compliant);
  writeFileSync(join(tmp, "package.json"), JSON.stringify({ scripts: {} }));
  expect(
    "a missing test:db script is a violation",
    runChecks(tmp, { skipVacuity: true }).violations.some((v) => v.file === "package.json"),
  );

  rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

if (SELF_TEST) selfTest();
else report(BACKEND_ROOT);
