#!/usr/bin/env node
/**
 * Production-operations evidence intake and gate.
 *
 * This script never runs a deployment probe and it never manufactures a passing
 * result. An operator captures redacted output from a real deployment under the
 * evidence root, then this script hashes and gates the submitted bundle.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const EVIDENCE_ROOT = resolve(ROOT, "architecture-refactor/final-refactor/evidence/42-production-ops");
const FORMAT = "streamlineos.production-ops-evidence/v1";
const RUNBOOKS = ["RB-01", "RB-02", "RB-03", "RB-04", "RB-05", "RB-06", "RB-07", "RB-08"];
const REQUIRED_ASSERTIONS = {
  "RB-01": ["independent-resource-identity", "cross-cell-credential-boundary"],
  "RB-02": ["pitr-retention", "restore-rpo"],
  "RB-03": ["physical-replica", "measured-replica-lag", "primary-fallback"],
  "RB-04": ["cell-recovery-rto-rpo", "regional-recovery", "organization-relocation"],
  "RB-05": ["production-shaped-load", "tenant-isolation-under-load", "headroom-40-percent"],
  "RB-06": ["live-alert-delivery", "human-acknowledgement", "release-observability"],
  "RB-07": ["invoice-derived-cell-cost", "seven-day-cost-trend", "operator-capacity-approval"],
  "RB-08": ["separate-resource-accounts", "per-cell-credentials", "separate-worker-deployment"],
};
const FORBIDDEN = /(?:--self-test|--dry-run|\bmock\b|\bfixture\b|\bfake\b|\bsimulat(?:e|ed|ion)\b)/i;
const SECRET = /(?:password|secret|token|api[_-]?key)\s*["']?\s*[:=]\s*["']?(?!<redacted>|\[redacted\]|redacted\b)[^\s,"'}]{8,}/i;

function usage() {
  process.stdout.write(`
Production-operations evidence intake and gate

  node src/scripts/production-ops-evidence.mjs capture --metadata=<path> [--out=<path>]
  node src/scripts/production-ops-evidence.mjs verify [--dir=<evidence-dir>]
  node src/scripts/production-ops-evidence.mjs --self-test

Capture only accepts redacted artifacts already inside:
  ${EVIDENCE_ROOT}

The gate is intentionally not satisfied by this script's self-test, a dry-run,
or evidence for a local/test/mock environment.
`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

function safePath(root, supplied) {
  if (typeof supplied !== "string" || supplied.length === 0) throw new Error("artifact path is missing");
  const full = resolve(root, supplied);
  if (!isInside(root, full)) throw new Error(`path escapes evidence root: ${supplied}`);
  if (!existsSync(full)) throw new Error(`artifact does not exist: ${supplied}`);
  if (lstatSync(full).isSymbolicLink()) throw new Error(`artifact may not be a symlink: ${supplied}`);
  if (!lstatSync(full).isFile()) throw new Error(`artifact is not a file: ${supplied}`);
  return full;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`invalid JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function isIsoDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function checksFor(record) {
  const errors = [];
  const required = REQUIRED_ASSERTIONS[record.runbook] ?? [];
  const add = (condition, message) => { if (!condition) errors.push(message); };
  add(record.format === FORMAT, "wrong or missing evidence format");
  add(RUNBOOKS.includes(record.runbook), `unsupported runbook ${String(record.runbook)}`);
  add(record.evidenceKind === "deployed-operator-attested", "evidenceKind must be deployed-operator-attested");
  add(record.live === true && record.synthetic !== true, "evidence must declare live=true and synthetic must not be true");
  const environment = record.environment ?? {};
  add(typeof environment.name === "string" && !/\b(local|dev|test|ci|mock|fake)\b/i.test(environment.name), "environment.name is absent or not deployment-like");
  add(typeof environment.region === "string" && environment.region.trim().length > 0, "environment.region is required");
  add(typeof environment.cell === "string" && environment.cell.trim().length > 0, "environment.cell is required");
  add(typeof environment.target === "string" && /^https:\/\//i.test(environment.target) && !/(localhost|127\.0\.0\.1|0\.0\.0\.0)/i.test(environment.target), "environment.target must be a non-local https endpoint");
  const release = record.release ?? {};
  add(typeof release.sha === "string" && /^[0-9a-f]{7,64}$/i.test(release.sha), "release.sha must be a git SHA");
  add(typeof release.topologySha256 === "string" && /^[0-9a-f]{64}$/i.test(release.topologySha256), "release.topologySha256 must be SHA-256");
  const dataset = record.dataset ?? {};
  add(typeof dataset.shape === "string" && dataset.shape.trim().length > 0, "dataset.shape is required");
  add(Number.isFinite(dataset.activeOrganizations) && dataset.activeOrganizations > 0, "dataset.activeOrganizations must be positive");
  const operator = record.operator ?? {};
  add(typeof operator.name === "string" && operator.name.trim().length > 1 && !/^(unknown|n\/a)$/i.test(operator.name), "named operator is required");
  add(isIsoDate(operator.approvedAt), "operator.approvedAt must be an ISO timestamp");
  const execution = record.execution ?? {};
  add(typeof execution.command === "string" && execution.command.trim().length > 0, "execution.command is required");
  add(execution.exitCode === 0, "execution.exitCode must be 0");
  add(isIsoDate(execution.startedAt) && isIsoDate(execution.finishedAt) && Date.parse(execution.finishedAt) >= Date.parse(execution.startedAt), "execution timestamps are invalid");
  add(!FORBIDDEN.test(JSON.stringify({ environment, dataset, execution })), "self-test, dry-run, mock, fixture, fake, or simulation content is forbidden");
  const artifacts = Array.isArray(record.artifacts) ? record.artifacts : [];
  add(artifacts.length > 0, "at least one hashed artifact is required");
  const assertions = Array.isArray(record.assertions) ? record.assertions : [];
  for (const id of required) {
    const item = assertions.find((assertion) => assertion?.id === id);
    add(item?.result === "pass", `required assertion is not a pass: ${id}`);
    add(isIsoDate(item?.observedAt), `required assertion lacks observedAt: ${id}`);
    add(artifacts.some((artifact) => artifact.path === item?.artifact), `required assertion is not linked to an artifact: ${id}`);
  }
  return errors;
}

function validateArtifact(record, artifact, root) {
  const full = safePath(root, artifact?.path);
  const bytes = readFileSync(full);
  const text = bytes.toString("utf8");
  if (artifact.sha256 !== sha256(bytes)) throw new Error(`artifact hash does not match: ${artifact.path}`);
  if (artifact.bytes !== bytes.length) throw new Error(`artifact byte count does not match: ${artifact.path}`);
  if (FORBIDDEN.test(text)) throw new Error(`artifact contains self-test, dry-run, mock, fixture, fake, or simulation wording: ${artifact.path}`);
  if (SECRET.test(text)) throw new Error(`artifact appears to contain an unredacted credential: ${artifact.path}`);
}

function collectJson(dir) {
  if (!existsSync(dir)) return [];
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) result.push(...collectJson(full));
    else if (entry.isFile() && entry.name.endsWith(".json") && !entry.name.endsWith(".input.json")) result.push(full);
  }
  return result;
}

function verify(dir) {
  const manifests = collectJson(dir);
  if (manifests.length === 0) throw new Error(`no evidence manifests found under ${dir}; deployed evidence has not been collected`);
  const seen = new Set();
  const failures = [];
  for (const manifestPath of manifests) {
    try {
      const record = readJson(manifestPath);
      const errors = checksFor(record);
      for (const artifact of record.artifacts ?? []) validateArtifact(record, artifact, dir);
      if (errors.length > 0) throw new Error(errors.join("; "));
      seen.add(record.runbook);
      process.stdout.write(`PASS ${record.runbook} ${relative(dir, manifestPath).replaceAll("\\", "/")}\n`);
    } catch (error) {
      failures.push(`${relative(dir, manifestPath).replaceAll("\\", "/")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const runbook of RUNBOOKS) if (!seen.has(runbook)) failures.push(`missing passing deployed evidence for ${runbook}`);
  if (failures.length > 0) throw new Error(`PRODUCTION OPS EVIDENCE GATE FAILED\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.stdout.write(`PRODUCTION OPS EVIDENCE GATE PASS: ${RUNBOOKS.length}/${RUNBOOKS.length} runbooks have hashed, operator-attested deployed evidence.\n`);
}

function capture(metadataPath, outputPath) {
  const inputPath = safePath(EVIDENCE_ROOT, metadataPath);
  const input = readJson(inputPath);
  const artifacts = (input.artifacts ?? []).map((artifact) => {
    const full = safePath(EVIDENCE_ROOT, artifact?.path);
    const bytes = readFileSync(full);
    return { path: relative(EVIDENCE_ROOT, full).replaceAll("\\", "/"), bytes: bytes.length, sha256: sha256(bytes) };
  });
  const record = { ...input, format: FORMAT, artifacts, capturedAt: new Date().toISOString() };
  const errors = checksFor(record);
  for (const artifact of record.artifacts) validateArtifact(record, artifact, EVIDENCE_ROOT);
  if (errors.length > 0) throw new Error(`refusing to capture evidence: ${errors.join("; ")}`);
  const target = outputPath
    ? resolve(EVIDENCE_ROOT, outputPath)
    : resolve(dirname(inputPath), `${basename(inputPath, ".input.json")}.json`);
  if (!isInside(EVIDENCE_ROOT, target)) throw new Error("output path must stay inside the production-ops evidence root");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  process.stdout.write(`CAPTURED ${record.runbook} evidence: ${relative(EVIDENCE_ROOT, target).replaceAll("\\", "/")}\n`);
}

function selfTest() {
  const testRoot = mkdtempSync(resolve(tmpdir(), "streamlineos-ops-evidence-"));
  try {
    const artifact = resolve(testRoot, "RB-01/output.txt");
    mkdirSync(dirname(artifact), { recursive: true });
    writeFileSync(artifact, "real deployment output: isolated resources verified\n", "utf8");
    const now = new Date().toISOString();
    const record = {
      format: FORMAT, runbook: "RB-01", evidenceKind: "deployed-operator-attested", live: true,
      environment: { name: "staging", region: "us-east-1", cell: "cell-us-01", target: "https://staging.example.invalid" },
      release: { sha: "a1b2c3d", topologySha256: "a".repeat(64) },
      dataset: { shape: "production-shaped sanitized", activeOrganizations: 1 },
      operator: { name: "Test Operator", approvedAt: now },
      execution: { command: "pnpm cell:isolation", exitCode: 0, startedAt: now, finishedAt: now },
      artifacts: [{ path: "RB-01/output.txt", bytes: readFileSync(artifact).length, sha256: sha256(readFileSync(artifact)) }],
      assertions: REQUIRED_ASSERTIONS["RB-01"].map((id) => ({ id, result: "pass", artifact: "RB-01/output.txt", observedAt: now })),
    };
    writeFileSync(resolve(testRoot, "RB-01/manifest.json"), JSON.stringify(record), "utf8");
    const directPass = checksFor(record).length === 0;
    validateArtifact(record, record.artifacts[0], testRoot);
    writeFileSync(artifact, "altered\n", "utf8");
    let tamperBlocked = false;
    try { validateArtifact(record, record.artifacts[0], testRoot); } catch { tamperBlocked = true; }
    record.execution.command = "pnpm cell:isolation --self-test";
    const selfTestBlocked = checksFor(record).some((error) => error.includes("forbidden"));
    const pass = directPass && tamperBlocked && selfTestBlocked;
    process.stdout.write(JSON.stringify({ selfTest: true, pass, checks: { validDeployedShapePasses: directPass, alteredArtifactBlocked: tamperBlocked, selfTestClaimBlocked: selfTestBlocked } }) + "\n");
    process.exitCode = pass ? 0 : 1;
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.length === 0) usage();
else if (args.includes("--self-test")) selfTest();
else if (args[0] === "capture") {
  const metadata = args.find((arg) => arg.startsWith("--metadata="))?.slice("--metadata=".length);
  const out = args.find((arg) => arg.startsWith("--out="))?.slice("--out=".length);
  if (!metadata) throw new Error("capture requires --metadata=<path>");
  capture(metadata, out);
} else if (args[0] === "verify") {
  const directory = args.find((arg) => arg.startsWith("--dir="))?.slice("--dir=".length);
  const root = directory ? resolve(EVIDENCE_ROOT, directory) : EVIDENCE_ROOT;
  if (!isInside(EVIDENCE_ROOT, root) && root !== EVIDENCE_ROOT) throw new Error("verification directory must stay inside the production-ops evidence root");
  verify(root);
} else {
  usage();
  process.exitCode = 1;
}
