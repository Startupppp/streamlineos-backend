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

const scriptDir = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(scriptDir, "../..");
const repoDir = resolve(backendDir, "..");
const templatePath = resolve(repoDir, "architecture-refactor/decisions/README.md");
const bundlePath = resolve(backendDir, "src/scripts/evidence/s05-evidence-bundle.json");

function assert(condition, message) {
  if (!condition) throw new Error(`SELF-TEST FAIL: ${message}`);
}

function containsAll(text, values, label) {
  for (const value of values) assert(text.includes(value), `${label} is missing ${value}`);
}

function validateApprovalTemplate() {
  assert(existsSync(templatePath), "approval/evidence template exists");
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
  assert(bundle.summary && typeof bundle.summary === "object", "check summary is present");
  assert(Number.isInteger(bundle.summary.total), "summary total is numeric");
  assert(Number.isInteger(bundle.summary.passed), "summary passed is numeric");
  assert(Number.isInteger(bundle.summary.failed), "summary failed is numeric");
  assert(bundle.summary.total === bundle.checks.length, "summary total matches checks");
  assert(bundle.summary.passed + bundle.summary.failed === bundle.summary.total, "summary counts reconcile");
  assert(Array.isArray(bundle.artifactHashes), "artifact hashes are present");
  for (const artifact of bundle.artifactHashes) {
    assert(typeof artifact.path === "string" && artifact.path.length > 0, "artifact path is present");
    assert(/^[a-f0-9]{64}$/i.test(artifact.sha256), `artifact hash is valid for ${artifact.path}`);
  }
}

function main() {
  validateApprovalTemplate();
  if (existsSync(bundlePath)) validateBundle(JSON.parse(readFileSync(bundlePath, "utf8")));
  process.stdout.write("S05 approval/evidence artifact contract passed.\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
}

