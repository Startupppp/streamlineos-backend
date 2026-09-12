#!/usr/bin/env node
/* global process */

/**
 * Validate the repository contract for S05 approval records and evidence bundles.
 *
 * This checks shape and anti-overclaiming rules only. It does not create an
 * approval, turn a repository self-test into deployed evidence, or require a
 * human signature to exist in the repository.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSPACE_ROOT, workspaceAvailable, workspaceUnreachableReason } from "./check-repo-paths.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(scriptDir, "../..");
// The decisions tree lives in the workspace docs repository, which is a sibling
// on a split checkout. Guessing "backendDir/.." resolved outside both repos and
// the gate died with a raw stack trace instead of saying it could not measure.
const templatePath = workspaceAvailable
  ? resolve(WORKSPACE_ROOT, "architecture-refactor/prd/completion-plan.md")
  : null;
const bundlePath = resolve(backendDir, "src/scripts/evidence/s05-evidence-bundle.json");
const REQUIRED_CHECKS = [
  "compliance",
  "purge-erasure",
  "purge-storage",
  "export-drill-contract",
  "legal-hold-drill-contract",
  "pitr-drill-contract",
  "retention",
  "immutability",
  "audit-log-privileges-contract",
  "migration-chain",
  "migration-discipline",
  "migration-ledger",
  "migration-rollback",
  "artifact-contract",
];

function assert(condition, message) {
  if (!condition) throw new Error(`SELF-TEST FAIL: ${message}`);
}

function containsAll(text, values, label) {
  for (const value of values) assert(text.includes(value), `${label} is missing ${value}`);
}

function validateApprovalTemplate() {
  if (templatePath === null) {
    process.stderr.write(
      "INCONCLUSIVE — check:s05-artifact-contract: the approval/evidence template could not be located, so the artifact contract was not validated.\n",
    );
    process.stderr.write(`  ${workspaceUnreachableReason()}\n`);
    process.exit(2);
  }
  assert(existsSync(templatePath), `approval/evidence template exists at ${templatePath}`);
  const text = readFileSync(templatePath, "utf8");
  containsAll(
    text,
    [
      "Decision identity",
      "Decision status:",
      "Scope:",
      "Accountable approval",
      "Evidence index",
      "Conditions and residual risk",
      "Release-authority disposition",
      "Attestation",
    ],
    "approval template section",
  );
  containsAll(
    text,
    ["Product", "Security", "Privacy/DPO", "Operations", "Legal", "Finance"],
    "approval function",
  );
  containsAll(
    text,
    ["Commit/environment", "Timestamp (UTC)", "Artifact path or hash"],
    "evidence index column",
  );
}

function validateBundle(bundle) {
  assert(bundle && typeof bundle === "object", "evidence bundle is an object");
  assert(bundle.schemaVersion === 1, "evidence bundle schema version is supported");
  assert(bundle.evidenceId === "S05", "evidence bundle identifies S05");
  assert(
    ["repository-only", "operator-declared-environment-not-verified"].includes(bundle.evidenceStatus),
    "evidence status cannot claim deployed verification",
  );
  assert(bundle.deployedEvidenceClaim === false, "repository collector cannot claim deployed evidence");
  assert(typeof bundle.claimRefusal === "string" && bundle.claimRefusal.length > 20, "claim refusal is present");
  assert(bundle.deployment && typeof bundle.deployment === "object", "deployment metadata is present");
  assert(bundle.checks && Array.isArray(bundle.checks), "check results are present");
  const checkIds = bundle.checks.map((check) => check?.id);
  assert(checkIds.length === REQUIRED_CHECKS.length, "check set has no missing or unexpected records");
  assert(new Set(checkIds).size === checkIds.length, "check IDs are unique");
  for (const checkId of REQUIRED_CHECKS) assert(checkIds.includes(checkId), `required check is present: ${checkId}`);
  for (const check of bundle.checks) {
    assert(typeof check.id === "string" && check.id.length > 0, "check ID is present");
    assert(typeof check.command === "string" && check.command.length > 0, `check command is present: ${check.id}`);
    assert(typeof check.startedAt === "string" && typeof check.endedAt === "string", `check timestamps are present: ${check.id}`);
    assert(Number.isInteger(check.exitCode), `check exit code is numeric: ${check.id}`);
    assert(check.exitCode >= 0, `check exit code is non-negative: ${check.id}`);
    assert(typeof check.output === "string", `check output is present: ${check.id}`);
  }
  assert(bundle.summary && typeof bundle.summary === "object", "check summary is present");
  assert(Number.isInteger(bundle.summary.total), "summary total is numeric");
  assert(Number.isInteger(bundle.summary.passed), "summary passed is numeric");
  assert(Number.isInteger(bundle.summary.failed), "summary failed is numeric");
  assert(bundle.summary.total === bundle.checks.length, "summary total matches checks");
  assert(bundle.summary.passed + bundle.summary.failed === bundle.summary.total, "summary counts reconcile");
  assert(bundle.summary.passed === bundle.checks.filter((check) => check.exitCode === 0).length, "passed count matches exit codes");
  assert(bundle.summary.failed === bundle.checks.filter((check) => check.exitCode !== 0).length, "failed count matches exit codes");
  assert(Array.isArray(bundle.artifactHashes), "artifact hashes are present");
  for (const artifact of bundle.artifactHashes) {
    assert(typeof artifact.path === "string" && artifact.path.length > 0, "artifact path is present");
    assert(/^[a-f0-9]{64}$/i.test(artifact.sha256), `artifact hash is valid for ${artifact.path}`);
  }
}

function main() {
  validateApprovalTemplate();
  assert(existsSync(bundlePath), "evidence bundle exists");
  validateBundle(JSON.parse(readFileSync(bundlePath, "utf8")));
  process.stdout.write("S05 approval/evidence artifact contract passed.\n");
}

function buildSyntheticBundle(overrides = {}) {
  const base = {
    schemaVersion: 1,
    evidenceId: "S05",
    evidenceStatus: "repository-only",
    deployedEvidenceClaim: false,
    claimRefusal: "This collector runs in the repository and has no access to a deployed environment.",
    deployment: { environment: "repository-only" },
    checks: REQUIRED_CHECKS.map((id) => ({
      id,
      command: `pnpm check:${id}`,
      startedAt: "2026-09-04T00:00:00.000Z",
      endedAt: "2026-09-04T00:00:01.000Z",
      exitCode: 0,
      output: "ok",
    })),
    summary: { total: REQUIRED_CHECKS.length, passed: REQUIRED_CHECKS.length, failed: 0 },
    artifactHashes: [
      { path: "contracts/benchmark-manifest.json", sha256: "a".repeat(64) },
    ],
  };
  return { ...base, ...overrides };
}

function expectFail(description, fn, expectedFragment) {
  let threw = null;
  try {
    fn();
  } catch (e) {
    threw = e;
  }
  if (!threw) {
    process.stderr.write(`[FAIL] ${description} — expected a throw but got none\n`);
    return false;
  }
  const msg = threw.message ?? String(threw);
  if (!msg.includes(expectedFragment)) {
    process.stderr.write(
      `[FAIL] ${description} — threw "${msg}" but expected to contain "${expectedFragment}"\n`,
    );
    return false;
  }
  process.stdout.write(`[pass] ${description}\n`);
  return true;
}

function expectPass(description, fn) {
  try {
    fn();
    process.stdout.write(`[pass] ${description}\n`);
    return true;
  } catch (e) {
    process.stderr.write(`[FAIL] ${description} — unexpected throw: ${e?.message ?? e}\n`);
    return false;
  }
}

function selfTest() {
  const results = [];

  results.push(expectPass("a valid synthetic bundle passes validateBundle", () =>
    validateBundle(buildSyntheticBundle()),
  ));

  results.push(expectFail(
    "deployedEvidenceClaim: true is rejected with the exact claim-refusal message",
    () => validateBundle(buildSyntheticBundle({ deployedEvidenceClaim: true })),
    "repository collector cannot claim deployed evidence",
  ));

  results.push(expectFail(
    "schemaVersion 2 is rejected (unsupported version)",
    () => validateBundle(buildSyntheticBundle({ schemaVersion: 2 })),
    "evidence bundle schema version is supported",
  ));

  results.push(expectFail(
    "wrong evidenceId is rejected",
    () => validateBundle(buildSyntheticBundle({ evidenceId: "S99" })),
    "evidence bundle identifies S05",
  ));

  results.push(expectFail(
    "a bundle claiming operator-verified deployment is rejected as deployed evidence",
    () => validateBundle(buildSyntheticBundle({ evidenceStatus: "deployed-verified" })),
    "evidence status cannot claim deployed verification",
  ));

  const missingCheck = buildSyntheticBundle();
  missingCheck.checks = missingCheck.checks.filter((c) => c.id !== "compliance");
  missingCheck.summary = {
    total: missingCheck.checks.length,
    passed: missingCheck.checks.length,
    failed: 0,
  };
  results.push(expectFail(
    "a bundle missing a required check ('compliance') is rejected",
    () => validateBundle(missingCheck),
    "check set has no missing or unexpected records",
  ));

  const wrongSummary = buildSyntheticBundle();
  wrongSummary.summary = { total: REQUIRED_CHECKS.length, passed: REQUIRED_CHECKS.length - 1, failed: 2 };
  results.push(expectFail(
    "a bundle with inconsistent summary counts is rejected",
    () => validateBundle(wrongSummary),
    "summary counts reconcile",
  ));

  results.push(expectFail(
    "a bundle with a malformed artifact hash is rejected",
    () => validateBundle(buildSyntheticBundle({ artifactHashes: [{ path: "x", sha256: "not-a-hash" }] })),
    "artifact hash is valid",
  ));

  const passed = results.filter(Boolean).length;
  const failed = results.filter((r) => !r).length;
  process.stdout.write(`\n${passed}/${results.length} checks passed\n`);
  if (failed > 0) {
    process.stderr.write(`${failed} self-test check(s) failed\n`);
    process.exitCode = 1;
  }
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
