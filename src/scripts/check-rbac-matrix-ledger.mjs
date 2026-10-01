#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(SCRIPT_DIR, "../..");
const JEST_BIN = join(BACKEND_ROOT, "node_modules", "jest", "bin", "jest.js");
const SPEC = "test/security/rbac-matrix/matrix\\.spec\\.ts$";
const ARTIFACT_DIR = join(BACKEND_ROOT, ".artifacts");
export const LEDGER_PATH = join(ARTIFACT_DIR, "rbac-matrix-ledger.json");
const BINDING_FLOOR = 150;
const SCENARIO_FLOOR = 100;
const SUITE_FLOOR = 15;
const TAG = "[check:rbac-matrix-ledger]";
const DIGEST_ROOTS = ["src", "test/security/rbac-matrix", "test/security/bola", "test/helpers"];

function filesUnder(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : filesUnder(path);
    return /\.(ts|mjs|json)$/.test(name) ? [path] : [];
  });
}

export function sourceDigest(root = BACKEND_ROOT) {
  const hash = createHash("sha256");
  const files = [
    ...DIGEST_ROOTS.flatMap((dir) => filesUnder(join(root, dir))),
    ...readdirSync(join(root, "test/security"))
      .filter((name) => /^bola-.*spec\.ts$/.test(name))
      .map((name) => join(root, "test/security", name)),
  ]
    .map((path) => relative(root, path).split("\\").join("/"))
    .sort();
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(join(root, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function testEnv(extra) {
  const env = { ...process.env, NODE_ENV: "test", NODE_OPTIONS: "--max-old-space-size=8192", ...extra };
  delete env.DATABASE_URL;
  delete env.DATABASE_URL_UNPOOLED;
  return env;
}

function runMatrix(ledgerPath, plantFailure) {
  rmSync(ledgerPath, { force: true });
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const result = spawnSync(
    process.execPath,
    [JEST_BIN, `--testPathPattern=${SPEC}`, "--no-coverage", "--forceExit"],
    {
      cwd: BACKEND_ROOT,
      encoding: "utf8",
      env: testEnv({ RBAC_MATRIX_LEDGER_OUT: ledgerPath, RBAC_MATRIX_PLANT_FAILURE: plantFailure ? "1" : "0" }),
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (!existsSync(ledgerPath)) {
    process.stderr.write(`${TAG} INCONCLUSIVE: the matrix run wrote no ledger\n`);
    process.stderr.write(`${(result.stdout ?? "") + (result.stderr ?? "")}`.slice(-3000));
    return null;
  }
  return JSON.parse(readFileSync(ledgerPath, "utf8"));
}

function failureSummary(result) {
  const failed = (result.assertionResults ?? []).filter((assertion) => assertion.status === "failed").map((assertion) => assertion.title);
  if (failed.length > 0) return `${failed.length} failing test(s): ${failed.slice(0, 5).join(" | ").slice(0, 600)}`;
  return `suite failed to run: ${String(result.message ?? "").replace(/\u001b\[[0-9;]*m/g, "").slice(0, 400)}`;
}

export function suiteVerdicts(entries, report) {
  const byPath = new Map(
    (report?.testResults ?? []).map((result) => [relative(BACKEND_ROOT, result.name).split("\\").join("/"), result]),
  );
  return entries.map((entry) => {
    if (entry.kind !== "suite" || !entry.required) return entry;
    const result = byPath.get(entry.suite);
    if (result === undefined) return { ...entry, status: "failed", detail: "the suite was scheduled but jest reported no result for it" };
    if (result.status === "passed") return { ...entry, status: "proven", detail: null };
    return { ...entry, status: "failed", detail: failureSummary(result) };
  });
}

function runSuites(entries) {
  const runnable = entries.filter((entry) => entry.kind === "suite" && entry.required).map((entry) => entry.suite);
  if (runnable.length === 0) return { testResults: [] };
  const reportPath = join(ARTIFACT_DIR, "rbac-matrix-suites.json");
  rmSync(reportPath, { force: true });
  const result = spawnSync(
    process.execPath,
    [JEST_BIN, "--runTestsByPath", ...runnable, "--no-coverage", "--forceExit", "--json", `--outputFile=${reportPath}`],
    { cwd: BACKEND_ROOT, encoding: "utf8", env: testEnv({}), maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (!existsSync(reportPath)) return null;
  return JSON.parse(readFileSync(reportPath, "utf8"));
}

export function recount(ledger, entries, digest) {
  const count = (status) => entries.filter((entry) => entry.status === status).length;
  return { ...ledger, sourceDigest: digest, proven: count("proven"), failed: count("failed"), unrun: count("unrun"), total: entries.length, entries };
}

export function evaluate(ledger) {
  const entries = ledger.entries ?? [];
  const failed = entries.filter((entry) => entry.status === "failed");
  const unrun = entries.filter((entry) => entry.status === "unrun");
  const requiredUnrun = unrun.filter((entry) => entry.required);
  const bindings = entries.filter((entry) => entry.kind === "binding").length;
  const suites = entries.filter((entry) => entry.kind === "suite");
  const seededRun = suites.filter((entry) => entry.suite.includes("seeded-e2e") && (entry.required || entry.status !== "unrun"));
  const problems = [];
  if (ledger.version !== 2) problems.push(`ledger version ${ledger.version}, expected 2`);
  if (failed.length > 0) problems.push(`${failed.length} failed entr(ies)`);
  if (requiredUnrun.length > 0) problems.push(`${requiredUnrun.length} required entr(ies) unrun`);
  if (seededRun.length > 0) problems.push(`${seededRun.length} seeded e2e suite(s) marked runnable or run`);
  if (bindings < BINDING_FLOOR) problems.push(`only ${bindings} scenario binding(s), floor ${BINDING_FLOOR}`);
  if ((ledger.scenarios ?? 0) < SCENARIO_FLOOR) problems.push(`only ${ledger.scenarios} scenario(s), floor ${SCENARIO_FLOOR}`);
  if (suites.length < SUITE_FLOOR) problems.push(`only ${suites.length} evidence suite(s), floor ${SUITE_FLOOR}`);
  return { ok: problems.length === 0, problems, failed, unrun, requiredUnrun, bindings, suites: suites.length };
}

export function freshness(ledger, digest = sourceDigest()) {
  if (ledger === null) return "missing";
  if (ledger.version !== 2 || ledger.sourceDigest === undefined) return "unversioned";
  return ledger.sourceDigest === digest ? "fresh" : "stale";
}

function report(ledger, verdict) {
  const out = [
    "",
    "RBAC Matrix Ledger",
    `  scenarios : ${ledger.scenarios}`,
    `  proven    : ${ledger.proven}`,
    `  failed    : ${ledger.failed}`,
    `  unrun     : ${ledger.unrun}`,
    `  total     : ${ledger.total}  (scenario bindings ${verdict.bindings}, evidence suites ${verdict.suites})`,
    "",
  ];
  for (const entry of verdict.failed) out.push(`  FAILED  ${entry.id}: ${entry.detail}`);
  if (verdict.unrun.length > 0) {
    out.push(`  UNRUN (${verdict.unrun.length}):`);
    for (const entry of verdict.unrun) out.push(`    ${entry.required ? "REQUIRED " : ""}${entry.id}${entry.detail ? ` — ${entry.detail}` : ""}`);
  }
  process.stdout.write(`${out.join("\n")}\n`);
}

function produce(ledgerPath, plantFailure, withSuites) {
  const digest = sourceDigest();
  const matrix = runMatrix(ledgerPath, plantFailure);
  if (matrix === null) return null;
  const suiteReport = withSuites ? runSuites(matrix.entries) : { testResults: [] };
  if (suiteReport === null) {
    process.stderr.write(`${TAG} INCONCLUSIVE: the evidence suite run wrote no report\n`);
    return null;
  }
  const entries = withSuites ? suiteVerdicts(matrix.entries, suiteReport) : matrix.entries;
  const ledger = recount(matrix, entries, digest);
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  return ledger;
}

function selfTest() {
  const checks = [];
  const check = (label, ok) => {
    checks.push(ok);
    process.stdout.write(`  ${ok ? "PASS" : "FAIL"}  ${label}\n`);
  };
  const scratch = join(ARTIFACT_DIR, "rbac-matrix-ledger.self-test.json");
  const clean = produce(scratch, false, false);
  check("a clean matrix run writes a ledger", clean !== null);
  if (clean) {
    const bindings = clean.entries.filter((entry) => entry.kind === "binding");
    check("every scenario binding of a clean run is proven", bindings.length > 0 && bindings.every((entry) => entry.status === "proven"));
    check("the ledger records one entry per scenario and adapter", new Set(bindings.map((entry) => `${entry.scenario}@${entry.adapter}`)).size === bindings.length);
    check("shared scenarios appear under more than one adapter", new Set(bindings.map((entry) => entry.scenario)).size < bindings.length);
    check("seeded e2e suites stay unrun and not required", clean.entries.filter((entry) => entry.kind === "suite" && entry.suite.includes("seeded-e2e")).every((entry) => entry.status === "unrun" && !entry.required));
    const unrunSuites = evaluate(clean);
    check("runnable suites left unrun fail the gate", !unrunSuites.ok && unrunSuites.requiredUnrun.every((entry) => entry.kind === "suite"));
    const runnable = clean.entries.filter((entry) => entry.kind === "suite" && entry.required);
    const passingReport = { testResults: runnable.map((entry) => ({ name: join(BACKEND_ROOT, entry.suite), status: "passed", assertionResults: [] })) };
    const allProven = recount(clean, suiteVerdicts(clean.entries, passingReport), clean.sourceDigest);
    check("a ledger whose suites all passed clears the gate", evaluate(allProven).ok);
    const oneFailing = {
      testResults: passingReport.testResults.map((result, index) =>
        index === 0 ? { ...result, status: "failed", assertionResults: [{ title: "planted", status: "failed" }] } : result,
      ),
    };
    const withFailedSuite = recount(clean, suiteVerdicts(clean.entries, oneFailing), clean.sourceDigest);
    check("a failed evidence suite fails the gate and is named", !evaluate(withFailedSuite).ok && withFailedSuite.entries.some((entry) => entry.kind === "suite" && entry.status === "failed" && /planted/.test(entry.detail)));
    const missingResult = recount(clean, suiteVerdicts(clean.entries, { testResults: passingReport.testResults.slice(1) }), clean.sourceDigest);
    check("a suite jest never reported is failed, not proven", !evaluate(missingResult).ok);
    const seededRunnable = { ...allProven, entries: allProven.entries.map((entry) => (entry.kind === "suite" && entry.suite.includes("seeded-e2e") ? { ...entry, required: true } : entry)) };
    check("a seeded e2e suite marked runnable fails the gate", !evaluate(seededRunnable).ok);
    check("a ledger from this tree is fresh", freshness(allProven) === "fresh");
    check("a ledger with another digest is stale", freshness({ ...allProven, sourceDigest: "0".repeat(64) }) === "stale");
    check("no ledger is missing", freshness(null) === "missing");
  }
  const planted = produce(scratch, true, false);
  check("a planted-failure run writes a ledger", planted !== null);
  if (planted) {
    const verdict = evaluate(planted);
    check("a planted failed binding fails the gate", !verdict.ok);
    check("the planted binding is the one reported failed", verdict.failed.some((entry) => entry.id === "planted-failure@service"));
  }
  rmSync(scratch, { force: true });
  const passed = checks.every(Boolean);
  process.stdout.write(`${TAG} self-test ${passed ? "PASS" : "FAIL"} (${checks.filter(Boolean).length}/${checks.length})\n`);
  return passed ? 0 : 1;
}

function run() {
  const ledger = produce(LEDGER_PATH, false, true);
  if (ledger === null) return 2;
  const verdict = evaluate(ledger);
  report(ledger, verdict);
  process.stdout.write(`${TAG} ledger written to ${relative(BACKEND_ROOT, LEDGER_PATH)}\n`);
  if (!verdict.ok) {
    process.stderr.write(`${TAG} FAIL: ${verdict.problems.join("; ")}\n`);
    return 1;
  }
  process.stdout.write(`${TAG} PASS: every binding and runnable suite proven, seeded suites unrun by design\n`);
  return 0;
}

function printDigest() {
  process.stdout.write(`${sourceDigest()}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exit(process.argv.includes("--self-test") ? selfTest() : process.argv.includes("--digest") ? printDigest() : run());
