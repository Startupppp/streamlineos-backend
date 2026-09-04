/**
 * Bite-proof for verify:permissions.
 *
 * verify:permissions is declared as an alias: both it and check:permission-keys
 * invoke the same script (check-permission-keys.mjs). This self-test:
 *   1. Proves the alias is exact by reading package.json and comparing the
 *      resolved command strings.
 *   2. Runs check:permission-keys:self-test and verifies it exits 0.
 *
 * If the alias were to silently drift (e.g., someone changed verify:permissions
 * to run a different script), step 1 would exit 1 with the specific message
 * "ALIAS DRIFT: verify:permissions command does not match check:permission-keys".
 * If the underlying self-test broke, step 2 would exit 1.
 *
 * Exits 0 when both checks pass. Exits 1 otherwise.
 */
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const DIR = dirname(fileURLToPath(import.meta.url));
const PKG_PATH = resolve(DIR, "..", "..", "package.json");

const pkg = JSON.parse(await readFile(PKG_PATH, "utf8"));
const scripts = pkg.scripts ?? {};

const verifyCmd = scripts["verify:permissions"] ?? "";
const checkCmd = scripts["check:permission-keys"] ?? "";
const checkSelfTestCmd = scripts["check:permission-keys:self-test"] ?? "";

process.stdout.write("=== verify:permissions alias self-test ===\n\n");
process.stdout.write(`verify:permissions        = "${verifyCmd}"\n`);
process.stdout.write(`check:permission-keys     = "${checkCmd}"\n\n`);

let exitCode = 0;

// 1. Prove the alias
if (verifyCmd !== checkCmd) {
  process.stdout.write("FAIL: ALIAS DRIFT: verify:permissions command does not match check:permission-keys\n");
  process.stdout.write(`  verify:permissions     = "${verifyCmd}"\n`);
  process.stdout.write(`  check:permission-keys  = "${checkCmd}"\n`);
  exitCode = 1;
} else {
  process.stdout.write("PASS: alias is exact — both invoke the same script\n\n");
}

// 2. Run check:permission-keys:self-test to confirm the underlying self-test works
if (checkSelfTestCmd) {
  process.stdout.write(`Running: ${checkSelfTestCmd}\n`);
  const result = spawnSync(
    process.execPath,
    checkSelfTestCmd.replace(/^node\s+/, "").split(/\s+/),
    {
      cwd: resolve(DIR, "..", ".."),
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    process.stdout.write(`FAIL: check:permission-keys:self-test exited ${result.status}\n`);
    exitCode = 1;
  } else {
    process.stdout.write(`PASS: check:permission-keys:self-test exited 0\n`);
  }
} else {
  process.stdout.write("FAIL: check:permission-keys:self-test not found in package.json\n");
  exitCode = 1;
}

process.exitCode = exitCode;
if (exitCode === 0)
  process.stdout.write("\n✓ verify:permissions is a verified alias of check:permission-keys, which has a passing self-test\n");
