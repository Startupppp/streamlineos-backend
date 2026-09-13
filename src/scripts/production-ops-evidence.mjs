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
import { WORKSPACE_ROOT, workspaceAvailable, workspaceUnreachableReason } from "./check-repo-paths.mjs";

/**
 * The evidence tree lives in the WORKSPACE docs repository, which is a sibling
 * checkout here. `resolve(scriptDir, "../../..")` guessed a depth and landed on
 * `<parent-of-backend>/architecture-refactor`, a directory that exists in no
 * layout this project uses -- measured 2026-09-03: the guess resolved to
 * `.../streamline/architecture-refactor/...` while the real tree is
 * `.../streamlineos-frontend/architecture-refactor/...`. Every capture wrote,
 * and every verify read, somewhere that was not the evidence root. Resolve it
 * from the marker instead, and fail loudly when it is absent rather than
 * composing onto a wrong root.
 */
const EVIDENCE_REL = ["architecture-refactor", "final-refactor", "evidence", "42-production-ops"];
const EVIDENCE_ROOT = workspaceAvailable ? resolve(WORKSPACE_ROOT, ...EVIDENCE_REL) : null;

function requireEvidenceRoot() {
  if (EVIDENCE_ROOT !== null) return EVIDENCE_ROOT;
  console.error(
    "INCONCLUSIVE - production-ops-evidence: the evidence tree could not be located, so nothing was captured or verified.",
  );
  console.error(`  ${workspaceUnreachableReason()}`);
  process.exit(2);
}
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
  ${EVIDENCE_ROOT ?? "(evidence tree not located - see check-repo-paths)"}

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
  const candidates = collectJson(dir);
  const manifests = [];
  for (const candidatePath of candidates) {
    let obj;
    try { obj = readJson(candidatePath); } catch { continue; }
    if (typeof obj?.format !== "string") continue;
    manifests.push({ path: candidatePath, record: obj });
  }
  if (manifests.length === 0) throw new Error(`no submitted evidence manifests found under ${dir}; deployed evidence has not been collected`);
  const seen = new Set();
  const failures = [];
  for (const { path: manifestPath, record } of manifests) {
    try {
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
  process.stdout.write(`NOTE: a parseable operator name/timestamp is not authentication of a human approval. OPS-004 requires the real accountable decision.\n`);
}

function capture(metadataPath, outputPath) {
  const evidenceRoot = requireEvidenceRoot();
  const inputPath = safePath(evidenceRoot, metadataPath);
  const input = readJson(inputPath);
  const artifacts = (input.artifacts ?? []).map((artifact) => {
    const full = safePath(evidenceRoot, artifact?.path);
    const bytes = readFileSync(full);
    return { path: relative(evidenceRoot, full).replaceAll("\\", "/"), bytes: bytes.length, sha256: sha256(bytes) };
  });
  const record = { ...input, format: FORMAT, artifacts, capturedAt: new Date().toISOString() };
  const errors = checksFor(record);
  for (const artifact of record.artifacts) validateArtifact(record, artifact, evidenceRoot);
  if (errors.length > 0) throw new Error(`refusing to capture evidence: ${errors.join("; ")}`);
  const target = outputPath
    ? resolve(evidenceRoot, outputPath)
    : resolve(dirname(inputPath), `${basename(inputPath, ".input.json")}.json`);
  if (!isInside(evidenceRoot, target)) throw new Error("output path must stay inside the production-ops evidence root");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  process.stdout.write(`CAPTURED ${record.runbook} evidence: ${relative(evidenceRoot, target).replaceAll("\\", "/")}\n`);
}

function selfTest() {
  const testRoot = mkdtempSync(resolve(tmpdir(), "streamlineos-ops-evidence-"));
  try {
    const checks = {};

    const buildRecord = (runbook, testDir) => {
      const assertionIds = REQUIRED_ASSERTIONS[runbook] ?? [];
      const artifactRelPath = `${runbook}/output.txt`;
      const artifactAbsPath = resolve(testDir, artifactRelPath);
      mkdirSync(dirname(artifactAbsPath), { recursive: true });
      writeFileSync(artifactAbsPath, `deployed output for ${runbook}\n`, "utf8");
      const bytes = readFileSync(artifactAbsPath);
      const now = new Date().toISOString();
      return {
        record: {
          format: FORMAT,
          runbook,
          evidenceKind: "deployed-operator-attested",
          live: true,
          environment: { name: "production-us", region: "us-east-1", cell: "cell-01", target: "https://api.example.invalid" },
          release: { sha: "abc1234def5678a", topologySha256: "a".repeat(64) },
          dataset: { shape: "production-shaped", activeOrganizations: 10 },
          operator: { name: "Release Operator", approvedAt: now },
          execution: { command: "pnpm cell:runbook", exitCode: 0, startedAt: now, finishedAt: now },
          artifacts: [{ path: artifactRelPath, bytes: bytes.length, sha256: sha256(bytes) }],
          assertions: assertionIds.map((id) => ({ id, result: "pass", artifact: artifactRelPath, observedAt: now })),
        },
        artifactAbsPath,
      };
    };

    const writeManifest = (testDir, runbook, overrides = {}) => {
      const { record, artifactAbsPath } = buildRecord(runbook, testDir);
      const merged = { ...record, ...overrides };
      const manifestPath = resolve(testDir, `${runbook}/manifest.json`);
      mkdirSync(dirname(manifestPath), { recursive: true });
      writeFileSync(manifestPath, JSON.stringify(merged, null, 2), "utf8");
      return { merged, artifactAbsPath };
    };

    const tryVerify = (dir) => {
      try { verify(dir); return { passed: true, message: "" }; }
      catch (e) { return { passed: false, message: e instanceof Error ? e.message : String(e) }; }
    };

    const dir1 = resolve(testRoot, "c1");
    for (const rb of RUNBOOKS) writeManifest(dir1, rb);
    writeFileSync(resolve(dir1, "raw-measurements.json"), JSON.stringify({ generatedAt: new Date().toISOString(), counts: [1, 2, 3] }), "utf8");
    const c1 = tryVerify(dir1);
    checks.case1_allPassBesideUnrelatedJson = c1.passed && !c1.message.includes("raw-measurements.json");

    const dir2 = resolve(testRoot, "c2");
    mkdirSync(dir2, { recursive: true });
    writeFileSync(resolve(dir2, "artifact-hashes.json"), JSON.stringify({ covers: ["foo"], generatedAt: new Date().toISOString() }), "utf8");
    const c2 = tryVerify(dir2);
    checks.case2_noManifestsError = !c2.passed && c2.message.includes("no submitted evidence manifests found");

    const dir3a = resolve(testRoot, "c3a");
    mkdirSync(dir3a, { recursive: true });
    writeFileSync(resolve(dir3a, "bad-runbook.json"), JSON.stringify({ format: FORMAT, runbook: "RB-99" }), "utf8");
    const c3a = tryVerify(dir3a);
    checks.case3a_unsupportedRunbookFails = !c3a.passed && c3a.message.includes("unsupported runbook RB-99");

    const dir3b = resolve(testRoot, "c3b");
    mkdirSync(dir3b, { recursive: true });
    writeFileSync(resolve(dir3b, "old-version.json"), JSON.stringify({ format: "streamlineos.production-ops-evidence/v0", runbook: "RB-01" }), "utf8");
    const c3b = tryVerify(dir3b);
    checks.case3b_wrongFormatVersionFails = !c3b.passed && c3b.message.includes("wrong or missing evidence format");

    const dir3c = resolve(testRoot, "c3c");
    const { merged: rb01c } = writeManifest(dir3c, "RB-01");
    writeFileSync(resolve(dir3c, "RB-01/manifest.json"), JSON.stringify({ ...rb01c, execution: { ...rb01c.execution, command: "pnpm cell:runbook --self-test" } }, null, 2), "utf8");
    const c3c = tryVerify(dir3c);
    checks.case3c_selfTestClaimBlocked = !c3c.passed && c3c.message.includes("self-test");

    const dir4 = resolve(testRoot, "c4");
    const { merged: rb01d } = writeManifest(dir4, "RB-01");
    writeFileSync(resolve(dir4, "RB-01/manifest.json"), JSON.stringify({ ...rb01d, assertions: [] }, null, 2), "utf8");
    const c4 = tryVerify(dir4);
    checks.case4_missingAssertionsFails = !c4.passed && c4.message.includes("required assertion is not a pass:");

    const dir5 = resolve(testRoot, "c5");
    const { artifactAbsPath: artifact5 } = writeManifest(dir5, "RB-02");
    writeFileSync(artifact5, "tampered content that changes the hash\n", "utf8");
    const c5 = tryVerify(dir5);
    checks.case5_tamperedArtifactFails = !c5.passed && c5.message.includes("artifact hash does not match");

    const dir6a = resolve(testRoot, "c6a");
    writeManifest(dir6a, "RB-03", { synthetic: true });
    const c6a = tryVerify(dir6a);
    checks.case6a_syntheticRejected = !c6a.passed && c6a.message.includes("evidence must declare live=true and synthetic must not be true");

    const dir6b = resolve(testRoot, "c6b");
    writeManifest(dir6b, "RB-04", { environment: { name: "dev-local", region: "local", cell: "local-01", target: "http://localhost:3000" } });
    const c6b = tryVerify(dir6b);
    checks.case6b_localTargetRejected = !c6b.passed;

    const pass = Object.values(checks).every(Boolean);
    process.stdout.write(JSON.stringify({ selfTest: true, pass, checks }) + "\n");
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
  const evidenceRoot = requireEvidenceRoot();
  const root = directory ? resolve(evidenceRoot, directory) : evidenceRoot;
  if (!isInside(evidenceRoot, root) && root !== evidenceRoot) throw new Error("verification directory must stay inside the production-ops evidence root");
  verify(root);
} else {
  usage();
  process.exitCode = 1;
}
