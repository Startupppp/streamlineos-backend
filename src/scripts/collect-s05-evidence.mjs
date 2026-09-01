#!/usr/bin/env node
/* global process, URL */
/**
 * Collect the reproducible S05 evidence bundle.
 *
 * The default mode runs repository-only checks. The current checks are all
 * repository/self-test checks, so this collector never upgrades them to a
 * deployed-evidence claim. --deployed records an operator-declared environment
 * for a future real-drill implementation but still refuses the claim.
 *
 * Usage:
 *   node src/scripts/collect-s05-evidence.mjs [--output=<path>]
 *   node src/scripts/collect-s05-evidence.mjs --deployed \
 *     --output=<path>                 # requires S05_DEPLOYED_ENVIRONMENT
 *   node src/scripts/collect-s05-evidence.mjs --self-test
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, platform, release, arch, userInfo } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(scriptDir, "../..");
const repoDir = resolve(backendDir, "..");
const args = process.argv.slice(2);
const selfTest = args.includes("--self-test");
const deployedRequested = args.includes("--deployed");
const outputArg = args.find((arg) => arg.startsWith("--output="));
const defaultOutput = resolve(backendDir, "src/scripts/evidence/s05-evidence-bundle.json");

const CHECKS = [
  {
    id: "compliance",
    command: "compliance-drill-e2e --self-test",
    args: ["src/scripts/compliance-drill-e2e.mjs", "--self-test"],
  },
  {
    id: "purge-erasure",
    command: "drill-erasure --self-test",
    args: ["src/scripts/drill-erasure.mjs", "--self-test"],
  },
  {
    id: "purge-storage",
    command: "drill-storage-purge --self-test",
    args: ["src/scripts/drill-storage-purge.mjs", "--self-test"],
  },
  {
    id: "retention",
    command: "check-retention-coverage --self-test",
    args: ["src/scripts/check-retention-coverage.mjs", "--self-test"],
  },
  {
    id: "immutability",
    command: "jest audit-log-immutability + journal-immutability",
    args: [
      "node_modules/jest/bin/jest.js",
      "src/modules/platform/audit-log-immutability.spec.ts",
      "src/modules/accounting/posting/journal-immutability.spec.ts",
      "--runInBand",
      "--forceExit",
    ],
  },
  {
    id: "audit-log-privileges-contract",
    command: "verify-audit-log-privileges --self-test",
    args: ["src/scripts/verify-audit-log-privileges.mjs", "--self-test"],
  },
  {
    id: "migration-chain",
    command: "verify-migration-chain --self-test",
    args: ["src/scripts/verify-migration-chain.mjs", "--self-test"],
  },
  {
    id: "migration-discipline",
    command: "check-migration-discipline --self-test",
    args: ["src/scripts/check-migration-discipline.mjs", "--self-test"],
  },
  {
    id: "migration-ledger",
    command: "check-migration-ledger --self-test",
    args: ["src/scripts/check-migration-ledger.mjs", "--self-test"],
  },
  {
    id: "migration-rollback",
    command: "check-migration-rollback --self-test",
    args: ["src/scripts/check-migration-rollback.mjs", "--self-test"],
  },
  {
    id: "artifact-contract",
    command: "check-s05-artifact-contract",
    args: ["src/scripts/check-s05-artifact-contract.mjs"],
  },
];

const REDACTIONS = [
  [/([?&](?:password|token|secret|key|access_token)=)[^&\s]+/gi, "$1[REDACTED]"],
  [/(postgres(?:ql)?:\/\/[^\s\n]+)/gi, (match) => redactUrl(match)],
  [/(\b(?:DATABASE_URL|DIRECT_DATABASE_URL|APP_DATABASE_URL|[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*)\s*=\s*)[^\s\n]+/gi, "$1[REDACTED]"],
];

function redactUrl(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "[REDACTED]";
      url.password = "[REDACTED]";
    }
    return url.toString();
  } catch {
    return "[REDACTED_URL]";
  }
}

function redact(value) {
  let result = String(value ?? "");
  for (const [pattern, replacement] of REDACTIONS) result = result.replace(pattern, replacement);
  return result;
}

function git(argsForGit) {
  const result = spawnSync("git", argsForGit, { cwd: repoDir, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

function runCheck(check) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, check.args, {
    cwd: backendDir,
    encoding: "utf8",
    env: process.env,
    windowsHide: true,
  });
  const endedAt = new Date().toISOString();
  return {
    id: check.id,
    command: `node ${check.command}`,
    startedAt,
    endedAt,
    exitCode: result.status ?? 1,
    output: redact(`${result.stdout ?? ""}${result.stderr ?? ""}`).trim(),
  };
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function collectFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(fullPath));
    else files.push(fullPath);
  }
  return files;
}

function artifactHashes(outputPath) {
  const paths = [
    resolve(backendDir, "package.json"),
    scriptDir,
    resolve(backendDir, "migrations/meta/_journal.json"),
  ];
  const files = paths.flatMap((path) => (existsSync(path) ? (path === scriptDir ? collectFiles(path) : [path]) : []));
  return files
    .filter((path) => resolve(path) !== resolve(outputPath))
    .sort()
    .map((path) => ({ path: relative(repoDir, path).replaceAll("\\", "/"), sha256: sha256File(path) }));
}

function assert(condition, message) {
  if (!condition) throw new Error(`SELF-TEST FAIL: ${message}`);
}

function testContract() {
  assert(redact("DATABASE_URL=postgresql://user:pass@example/db") === "DATABASE_URL=[REDACTED]", "database URL is redacted");
  assert(redact("https://example.test?a=1&token=secret") === "https://example.test?a=1&token=[REDACTED]", "query secret is redacted");
  assert(!redact("postgresql://user:pass@example/db").includes("pass"), "URL password is redacted");
  assert(!deployedRequested, "self-test must not imply deployment");
  assert(!process.env.S05_DEPLOYED_ENVIRONMENT, "self-test must not inherit a deployment marker");
  process.stdout.write("S05 collector contract self-test passed.\n");
}

function buildBundle(results, outputPath, startedAt, endedAt) {
  const marker = process.env.S05_DEPLOYED_ENVIRONMENT?.trim() || null;
  // The CHECKS list contains self-tests, not deployed drills. Never let a
  // caller turn a marker into evidence by assertion alone.
  const deployedClaim = false;
  return {
    schemaVersion: 1,
    evidenceId: "S05",
    evidenceStatus: deployedRequested && marker
      ? "operator-declared-environment-not-verified"
      : "repository-only",
    deployedEvidenceClaim: deployedClaim,
    claimRefusal: "The current checks are repository/self-tests. A marker records environment identity but cannot create deployed evidence; run real disposable-environment drills and attach their redacted output.",
    deployment: {
      requested: deployedRequested,
      markerPresent: Boolean(marker),
      environment: marker,
    },
    datasetShape: {
      mode: deployedClaim ? "operator-declared-deployed-environment" : "repository-self-tests",
      syntheticRecordsCreated: false,
      piiCaptured: false,
      note: "This bundle records check outputs and metadata only; it does not export application data.",
    },
    execution: { startedAt, endedAt },
    commit: {
      sha: git(["rev-parse", "HEAD"]),
      branch: git(["branch", "--show-current"]),
      dirty: git(["status", "--porcelain"]).length > 0,
    },
    environment: {
      node: process.version,
      platform: platform(),
      release: release(),
      arch: arch(),
      user: userInfo().username,
      cwd: backendDir,
      envVarPresence: Object.fromEntries(
        ["DATABASE_URL", "APP_DATABASE_URL", "S05_DEPLOYED_ENVIRONMENT"].map((name) => [name, Boolean(process.env[name])]),
      ),
    },
    checks: results,
    summary: {
      total: results.length,
      passed: results.filter((result) => result.exitCode === 0).length,
      failed: results.filter((result) => result.exitCode !== 0).length,
    },
    artifactHashes: artifactHashes(outputPath),
  };
}

function main() {
  if (selfTest) testContract();
  if (deployedRequested && !process.env.S05_DEPLOYED_ENVIRONMENT?.trim()) {
    throw new Error(
      "--deployed requires a non-empty S05_DEPLOYED_ENVIRONMENT marker; refusing to emit a successful repository-only result",
    );
  }
  const outputPath = outputArg ? resolve(backendDir, outputArg.slice("--output=".length)) : defaultOutput;
  const startedAt = new Date().toISOString();
  const results = CHECKS.map(runCheck);
  const endedAt = new Date().toISOString();
  const bundle = buildBundle(results, outputPath, startedAt, endedAt);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  process.stdout.write(`WROTE ${outputPath}\n`);
  process.stdout.write(`STATUS ${bundle.evidenceStatus}\n`);
  process.stdout.write(`CHECKS ${bundle.summary.passed}/${bundle.summary.total} passed\n`);
  process.exitCode = bundle.summary.failed === 0 ? 0 : 1;
}

try {
  main();
} catch (error) {
  if (selfTest) rmSync(resolve(tmpdir(), "s05-evidence-self-test"), { recursive: true, force: true });
  process.stderr.write(`S05 evidence collector failed: ${redact(error?.stack ?? error)}\n`);
  process.exitCode = 1;
}
