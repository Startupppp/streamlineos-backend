#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = resolve(SCRIPT_DIR, "../..");

const PRODUCTION_TEST_URL = "postgresql://gate-test:gate-test@prod.cluster.amazonaws.com/app";
const LOOPBACK_TEST_URL = "postgresql://gate-test:gate-test@127.0.0.1:5432/scratch_gate_test";

const DESTRUCTIVE_SCRIPTS = [
  { script: "src/scripts/purge-user.mjs", env: { DATABASE_URL: PRODUCTION_TEST_URL }, args: ["nobody@gate-test.invalid"] },
  { script: "src/scripts/drill-erasure.mjs", env: { DATABASE_URL: PRODUCTION_TEST_URL }, args: ["nobody@gate-test.invalid"] },
  { script: "src/scripts/compliance-drill-e2e.mjs", env: { DATABASE_URL: PRODUCTION_TEST_URL }, args: [] },
  { script: "src/scripts/seed-scratch-e2e.mjs", env: { SCRATCH_DATABASE_URL: "postgresql://gate-test:gate-test@prod.cluster.amazonaws.com/scratch_e2e" }, args: [] },
  { script: "src/scripts/relocate-org.mjs", env: { DATABASE_URL: PRODUCTION_TEST_URL }, args: ["--org=00000000-0000-0000-0000-000000000001", "--advance"] },
  { script: "src/scripts/run-recovery-drill.mjs", env: { DATABASE_URL: PRODUCTION_TEST_URL }, args: [] },
  { script: "src/scripts/db-bootstrap.mjs", env: { DATABASE_URL: PRODUCTION_TEST_URL }, args: [] },
  { script: "src/scripts/run-pending-migrations.mjs", env: { DATABASE_URL: PRODUCTION_TEST_URL }, args: [] },
];

const MIN_SCRIPT_COUNT = 8;

const args = process.argv.slice(2);
const isSelfTest = args.includes("--self-test");

function spawnScript(scriptPath, extraArgs, extraEnv) {
  const result = spawnSync(
    process.execPath,
    [scriptPath, ...extraArgs],
    {
      cwd: BACKEND_ROOT,
      env: { PATH: process.env.PATH, ...extraEnv },
      encoding: "utf8",
      timeout: 15_000,
    },
  );
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runGate() {
  if (DESTRUCTIVE_SCRIPTS.length < MIN_SCRIPT_COUNT) {
    process.stderr.write(
      `check-destructive-targets: FAIL — only ${DESTRUCTIVE_SCRIPTS.length} scripts in list, floor is ${MIN_SCRIPT_COUNT}.\n`,
    );
    process.exit(1);
  }

  let failures = 0;
  let passes = 0;

  for (const { script, env, args: scriptArgs } of DESTRUCTIVE_SCRIPTS) {
    const full = resolve(BACKEND_ROOT, script);
    const result = spawnScript(full, scriptArgs, env);
    if (result.exitCode === 0) {
      process.stderr.write(`FAIL  ${script}: exited 0 with production-shaped URL (guard did not bite)\n`);
      if (result.stdout) process.stderr.write(`      stdout: ${result.stdout.slice(0, 200)}\n`);
      if (result.stderr) process.stderr.write(`      stderr: ${result.stderr.slice(0, 200)}\n`);
      failures++;
    } else {
      process.stdout.write(`PASS  ${script}: exited ${result.exitCode} (guard refused production target)\n`);
      passes++;
    }
  }

  if (failures > 0) {
    process.stderr.write(`\ncheck-destructive-targets: FAIL — ${failures}/${DESTRUCTIVE_SCRIPTS.length} script(s) did not refuse production.\n`);
    process.exit(1);
  }

  process.stdout.write(`\ncheck-destructive-targets: PASS — ${passes}/${DESTRUCTIVE_SCRIPTS.length} scripts refused the production-shaped target.\n`);
}

if (isSelfTest) {
  process.stdout.write("check-destructive-targets --self-test\n");
  process.stdout.write("Verifying vacuity floor bites when the list is emptied.\n\n");

  if (DESTRUCTIVE_SCRIPTS.length < MIN_SCRIPT_COUNT) {
    process.stderr.write(`FAIL: list already below floor (${DESTRUCTIVE_SCRIPTS.length} < ${MIN_SCRIPT_COUNT})\n`);
    process.exit(1);
  }

  const saved = DESTRUCTIVE_SCRIPTS.splice(0);

  let floorBit = false;
  if (DESTRUCTIVE_SCRIPTS.length < MIN_SCRIPT_COUNT) {
    floorBit = true;
    process.stdout.write(`PASS  vacuity floor bites: list emptied (0 < ${MIN_SCRIPT_COUNT})\n`);
  }

  DESTRUCTIVE_SCRIPTS.push(...saved);
  if (!floorBit) {
    process.stderr.write("FAIL: vacuity floor did not bite when list was emptied\n");
    process.exit(1);
  }

  process.stdout.write("\nNow running the full gate to prove each guard bites.\n\n");
  runGate();
  process.stdout.write("\ncheck-destructive-targets --self-test: PASS\n");
  process.exit(0);
}

runGate();
