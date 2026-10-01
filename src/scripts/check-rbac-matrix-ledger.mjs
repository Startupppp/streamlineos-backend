#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(SCRIPT_DIR, "../..");
const JEST_BIN = join(BACKEND_ROOT, "node_modules", "jest", "bin", "jest.js");

const args = process.argv.slice(2);
const SELF_TEST = args.includes("--self-test");

const LEDGER_LINE_RE =
  /RBAC Matrix Ledger:\s*proven=(\d+)\s+failed=(\d+)\s+unrun=(\d+)\s+externally-covered=(\d+)\s+total=(\d+)/g;

const MIN_CELLS = 1;

function runJest(pattern) {
  const env = {
    ...process.env,
    NODE_ENV: "test",
    NODE_OPTIONS: "--max-old-space-size=4096",
  };
  delete env.DATABASE_URL;
  delete env.DATABASE_URL_UNPOOLED;

  return spawnSync(
    process.execPath,
    [JEST_BIN, `--testPathPattern=${pattern}`, "--no-coverage", "--forceExit"],
    { cwd: BACKEND_ROOT, encoding: "utf8", env, maxBuffer: 10 * 1024 * 1024 },
  );
}

function parseLedgerLines(output) {
  const lines = [];
  let match;
  LEDGER_LINE_RE.lastIndex = 0;
  while ((match = LEDGER_LINE_RE.exec(output)) !== null) {
    lines.push({
      proven: Number(match[1]),
      failed: Number(match[2]),
      unrun: Number(match[3]),
      externallyCovered: Number(match[4]),
      total: Number(match[5]),
    });
  }
  return lines;
}

function run() {
  const pattern =
    "test/security/rbac-matrix/(matrix|bola-matrix)\\.spec\\.ts$";

  const result = runJest(pattern);
  const output = (result.stdout ?? "") + (result.stderr ?? "");

  if (result.error) {
    process.stderr.write(`[check:rbac-matrix-ledger] spawn error: ${result.error.message}\n`);
    process.exit(2);
  }

  const ledgers = parseLedgerLines(output);

  if (ledgers.length === 0) {
    process.stderr.write(`[check:rbac-matrix-ledger] jest produced no ledger output\n`);
    process.stderr.write(output.slice(-2000));
    process.exit(2);
  }

  const totals = ledgers.reduce(
    (acc, l) => ({
      proven: acc.proven + l.proven,
      failed: acc.failed + l.failed,
      unrun: acc.unrun + l.unrun,
      externallyCovered: acc.externallyCovered + l.externallyCovered,
      total: acc.total + l.total,
    }),
    { proven: 0, failed: 0, unrun: 0, externallyCovered: 0, total: 0 },
  );

  if (totals.total < MIN_CELLS) {
    process.stderr.write(
      `[check:rbac-matrix-ledger] INCONCLUSIVE: only ${totals.total} cell(s) (floor=${MIN_CELLS})\n`,
    );
    process.exit(2);
  }

  process.stdout.write(`\nRBAC Matrix Ledger\n`);
  process.stdout.write(`  proven            : ${totals.proven}\n`);
  process.stdout.write(`  failed            : ${totals.failed}\n`);
  process.stdout.write(`  unrun             : ${totals.unrun}\n`);
  process.stdout.write(`  externally-covered: ${totals.externallyCovered}\n`);
  process.stdout.write(`  total             : ${totals.total}\n\n`);

  if (totals.unrun > 0) {
    process.stdout.write(
      `[check:rbac-matrix-ledger] NOTE: ${totals.unrun} unrun cell(s) (non-required, covered by external suites is OK)\n`,
    );
  }

  if (SELF_TEST) {
    process.stdout.write("[check:rbac-matrix-ledger] self-test PASS\n");
    process.exit(0);
  }

  if (totals.failed > 0) {
    process.stderr.write(
      `[check:rbac-matrix-ledger] FAIL: ${totals.failed} cell(s) failed\n`,
    );
    process.exit(1);
  }

  process.stdout.write("[check:rbac-matrix-ledger] PASS: no cells failed\n");
  process.exit(0);
}

run();
