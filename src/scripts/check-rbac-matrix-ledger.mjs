#!/usr/bin/env node
/**
 * check-rbac-matrix-ledger.mjs
 *
 * Runs the RBAC verification matrix spec and reports the ledger: proven ·
 * failed · unrun per cell.  A declared-but-unrun cell is printed as UNRUN
 * rather than silently counted as green — that is the whole point of the
 * matrix module.
 *
 * The script runs jest with `--testPathPattern` so only the matrix spec is
 * exercised.  DATABASE_URL is explicitly unset so no DB connection is
 * attempted (same precaution as all other mock-backed spec gates).
 *
 * Exit codes:
 *   0   all declared cells are proven (unrun = 0, failed = 0)
 *   1   one or more cells are failed or unrun
 *   2   the spec itself did not produce output (vacuity guard)
 *
 * Usage:
 *   node src/scripts/check-rbac-matrix-ledger.mjs
 *   node src/scripts/check-rbac-matrix-ledger.mjs --self-test
 */

import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(SCRIPT_DIR, "../..");
const JEST_BIN = join(BACKEND_ROOT, "node_modules", ".bin", "jest");

const args = process.argv.slice(2);
const SELF_TEST = args.includes("--self-test");

const LEDGER_LINE_RE = /RBAC Matrix Ledger:\s*proven=(\d+)\s+failed=(\d+)\s+unrun=(\d+)\s+total=(\d+)/;
const MIN_CELLS = 1;

function run() {
  let output = "";
  try {
    output = execFileSync(
      process.execPath,
      [
        JEST_BIN,
        "--testPathPattern=test/security/rbac-matrix/matrix\\.spec\\.ts",
        "--no-coverage",
        "--forceExit",
      ],
      {
        cwd: BACKEND_ROOT,
        encoding: "utf8",
        stdio: ["inherit", "pipe", "pipe"],
        env: {
          ...process.env,
          DATABASE_URL: undefined,
          DATABASE_URL_UNPOOLED: undefined,
          NODE_ENV: "test",
        },
      },
    );
  } catch (err) {
    const execError = err;
    output = (execError.stdout ?? "") + (execError.stderr ?? "");
    // Jest exits non-zero when tests fail; we handle that below after parsing
    if (!output.includes("RBAC Matrix Ledger")) {
      process.stderr.write(`[check:rbac-matrix-ledger] jest produced no ledger output\n`);
      process.stderr.write(output.slice(-2000));
      process.exit(2);
    }
  }

  const match = output.match(LEDGER_LINE_RE);
  if (!match) {
    process.stderr.write("[check:rbac-matrix-ledger] ERROR: ledger line not found in jest output\n");
    process.stderr.write(output.slice(-2000));
    process.exit(2);
  }

  const proven = Number(match[1]);
  const failed = Number(match[2]);
  const unrun = Number(match[3]);
  const total = Number(match[4]);

  if (total < MIN_CELLS) {
    process.stderr.write(
      `[check:rbac-matrix-ledger] INCONCLUSIVE: only ${total} cell(s) declared (floor=${MIN_CELLS})\n`,
    );
    process.exit(2);
  }

  process.stdout.write(`\nRBAC Matrix Ledger\n`);
  process.stdout.write(`  proven : ${proven}\n`);
  process.stdout.write(`  failed : ${failed}\n`);
  process.stdout.write(`  unrun  : ${unrun}\n`);
  process.stdout.write(`  total  : ${total}\n\n`);

  if (SELF_TEST) {
    if (total < MIN_CELLS) {
      process.stderr.write("[check:rbac-matrix-ledger] self-test FAIL: no cells found\n");
      process.exit(1);
    }
    process.stdout.write("[check:rbac-matrix-ledger] self-test PASS\n");
    process.exit(0);
  }

  if (failed > 0 || unrun > 0) {
    process.stderr.write(
      `[check:rbac-matrix-ledger] FAIL: failed=${failed} unrun=${unrun}\n`,
    );
    process.exit(1);
  }

  process.stdout.write("[check:rbac-matrix-ledger] PASS: all cells proven\n");
  process.exit(0);
}

run();
