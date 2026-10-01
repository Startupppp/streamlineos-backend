#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(SCRIPT_DIR, "../..");
const JEST_BIN = join(BACKEND_ROOT, "node_modules", "jest", "bin", "jest.js");
const SPEC = "test/security/rbac-matrix/matrix\\.spec\\.ts$";
const ARTIFACT_DIR = join(BACKEND_ROOT, ".artifacts");
export const LEDGER_PATH = join(ARTIFACT_DIR, "rbac-matrix-ledger.json");
const EXECUTABLE_FLOOR = 60;
const DECLARED_FLOOR = 25;
const TAG = "[check:rbac-matrix-ledger]";

function runMatrix(ledgerPath, plantFailure) {
  rmSync(ledgerPath, { force: true });
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const env = {
    ...process.env,
    NODE_ENV: "test",
    NODE_OPTIONS: "--max-old-space-size=6144",
    RBAC_MATRIX_LEDGER_OUT: ledgerPath,
    RBAC_MATRIX_PLANT_FAILURE: plantFailure ? "1" : "0",
  };
  delete env.DATABASE_URL;
  delete env.DATABASE_URL_UNPOOLED;
  const result = spawnSync(
    process.execPath,
    [JEST_BIN, `--testPathPattern=${SPEC}`, "--no-coverage", "--forceExit"],
    { cwd: BACKEND_ROOT, encoding: "utf8", env, maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (!existsSync(ledgerPath)) {
    process.stderr.write(`${TAG} INCONCLUSIVE: the matrix run wrote no ledger\n`);
    process.stderr.write(`${(result.stdout ?? "") + (result.stderr ?? "")}`.slice(-3000));
    return null;
  }
  return JSON.parse(readFileSync(ledgerPath, "utf8"));
}

export function evaluate(ledger) {
  const entries = ledger.entries;
  const failed = entries.filter((entry) => entry.status === "failed");
  const unrun = entries.filter((entry) => entry.status === "unrun");
  const requiredUnrun = unrun.filter((entry) => entry.required);
  const executable = entries.filter((entry) => entry.kind === "executable").length;
  const declared = entries.filter((entry) => entry.kind === "declared").length;
  const problems = [];
  if (failed.length > 0) problems.push(`${failed.length} failed cell(s)`);
  if (requiredUnrun.length > 0) problems.push(`${requiredUnrun.length} required cell(s) unrun`);
  if (executable < EXECUTABLE_FLOOR) problems.push(`only ${executable} executable cell(s), floor ${EXECUTABLE_FLOOR}`);
  if (declared < DECLARED_FLOOR) problems.push(`only ${declared} declared cell(s), floor ${DECLARED_FLOOR}`);
  return { ok: problems.length === 0, problems, failed, unrun, requiredUnrun, executable, declared };
}

function report(ledger, verdict) {
  const out = [
    "",
    "RBAC Matrix Ledger",
    `  proven  : ${ledger.proven}`,
    `  failed  : ${ledger.failed}`,
    `  unrun   : ${ledger.unrun}`,
    `  total   : ${ledger.total}  (executable ${verdict.executable}, declared ${verdict.declared})`,
    "",
  ];
  for (const entry of verdict.failed) out.push(`  FAILED  ${entry.id}: ${entry.detail}`);
  if (verdict.unrun.length > 0) {
    out.push(`  UNRUN (${verdict.unrun.length}) — not executed by this run; evidence lives elsewhere:`);
    for (const entry of verdict.unrun)
      out.push(`    ${entry.required ? "REQUIRED " : ""}${entry.id}${entry.evidenceSuite ? ` -> ${entry.evidenceSuite}` : ""}`);
  }
  process.stdout.write(`${out.join("\n")}\n`);
}

function selfTest() {
  const checks = [];
  const check = (label, ok) => {
    checks.push(ok);
    process.stdout.write(`  ${ok ? "PASS" : "FAIL"}  ${label}\n`);
  };

  const clean = runMatrix(LEDGER_PATH, false);
  check("a clean matrix run writes a ledger", clean !== null);
  if (clean) {
    const verdict = evaluate(clean);
    check("a clean matrix run passes the gate", verdict.ok);
    check("a clean matrix run has zero failed cells", clean.failed === 0);
    check("declared suites are visible as unrun", verdict.unrun.length > 0 && verdict.requiredUnrun.length === 0);
  }

  const plantedPath = join(ARTIFACT_DIR, "rbac-matrix-ledger.planted.json");
  const planted = runMatrix(plantedPath, true);
  check("a planted-failure run writes a ledger", planted !== null);
  if (planted) {
    const verdict = evaluate(planted);
    check("a planted failed cell fails the gate", !verdict.ok);
    check("the planted cell is the one reported failed", verdict.failed.some((entry) => entry.id === "planted-failure"));
  }
  rmSync(plantedPath, { force: true });

  if (clean) {
    const withRequiredUnrun = {
      ...clean,
      entries: clean.entries.map((entry, index) =>
        index === clean.entries.findIndex((candidate) => candidate.required)
          ? { ...entry, status: "unrun", detail: null }
          : entry,
      ),
    };
    check("a required cell left unrun fails the gate", !evaluate(withRequiredUnrun).ok);
  }

  const passed = checks.every(Boolean);
  process.stdout.write(`${TAG} self-test ${passed ? "PASS" : "FAIL"} (${checks.filter(Boolean).length}/${checks.length})\n`);
  return passed ? 0 : 1;
}

function run() {
  const ledger = runMatrix(LEDGER_PATH, false);
  if (ledger === null) return 2;
  const verdict = evaluate(ledger);
  report(ledger, verdict);
  process.stdout.write(`${TAG} ledger written to ${relative(BACKEND_ROOT, LEDGER_PATH)}\n`);
  if (!verdict.ok) {
    process.stderr.write(`${TAG} FAIL: ${verdict.problems.join("; ")}\n`);
    return 1;
  }
  process.stdout.write(`${TAG} PASS: no failed cells, no required cell unrun\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exit(process.argv.includes("--self-test") ? selfTest() : run());
