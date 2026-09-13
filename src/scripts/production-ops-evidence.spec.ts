import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

jest.setTimeout(120_000);

const BACKEND_ROOT = resolve(__dirname, "../..");
const GATE = resolve(BACKEND_ROOT, "src/scripts/production-ops-evidence.mjs");

const FORMAT = "streamlineos.production-ops-evidence/v1";
const SUBMISSION_INDEX_FILENAME = "submission-index.json";
const SUBMISSION_INDEX_FORMAT = "streamlineos.ops-submission-index/v1";
const RUNBOOKS = ["RB-01","RB-02","RB-03","RB-04","RB-05","RB-06","RB-07","RB-08"];
const REQUIRED_ASSERTIONS: Record<string, string[]> = {
  "RB-01": ["independent-resource-identity","cross-cell-credential-boundary"],
  "RB-02": ["pitr-retention","restore-rpo"],
  "RB-03": ["physical-replica","measured-replica-lag","primary-fallback"],
  "RB-04": ["cell-recovery-rto-rpo","regional-recovery","organization-relocation"],
  "RB-05": ["production-shaped-load","tenant-isolation-under-load","headroom-40-percent"],
  "RB-06": ["live-alert-delivery","human-acknowledgement","release-observability"],
  "RB-07": ["invoice-derived-cell-cost","seven-day-cost-trend","operator-capacity-approval"],
  "RB-08": ["separate-resource-accounts","per-cell-credentials","separate-worker-deployment"],
};

interface GateRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runGate(args: readonly string[], extraEnv: Record<string, string> = {}): GateRun {
  try {
    const stdout = execFileSync(process.execPath, [GATE, ...args], {
      cwd: BACKEND_ROOT,
      encoding: "utf8",
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeWorkspace(): { workspaceRoot: string; evidenceRoot: string; cleanup: () => void } {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "streamlineos-ops-spec-"));
  const markerDir = join(workspaceRoot, "architecture-refactor", "prd");
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(join(markerDir, "completion-plan.md"), "# marker\n", "utf8");
  const evidenceRoot = join(workspaceRoot, "architecture-refactor", "final-refactor", "evidence", "42-production-ops");
  mkdirSync(evidenceRoot, { recursive: true });
  return { workspaceRoot, evidenceRoot, cleanup: () => rmSync(workspaceRoot, { recursive: true, force: true }) };
}

function writeManifest(evidenceRoot: string, runbook: string, overrides: Record<string, unknown> = {}): string {
  const artifactRelPath = `${runbook}/output.txt`;
  const artifactAbsPath = join(evidenceRoot, runbook, "output.txt");
  mkdirSync(join(evidenceRoot, runbook), { recursive: true });
  writeFileSync(artifactAbsPath, `deployed output for ${runbook}\n`, "utf8");
  const artifactBytes = readFileSync(artifactAbsPath);
  const artifact = { relPath: artifactRelPath, bytes: artifactBytes.length, hash: sha256(artifactBytes) };
  const assertionIds = REQUIRED_ASSERTIONS[runbook] ?? [];
  const now = new Date().toISOString();
  const record = {
    format: FORMAT,
    runbook,
    evidenceKind: "deployed-operator-attested",
    live: true,
    environment: { name: "production-us", region: "us-east-1", cell: "cell-01", target: "https://api.example.invalid" },
    release: { sha: "abc1234def5678a", topologySha256: "a".repeat(64) },
    dataset: { shape: "production-shaped", activeOrganizations: 10 },
    operator: { name: "Release Operator", approvedAt: now },
    execution: { command: "pnpm cell:runbook", exitCode: 0, startedAt: now, finishedAt: now },
    artifacts: [{ path: artifact.relPath, bytes: artifact.bytes, sha256: artifact.hash }],
    assertions: assertionIds.map((id) => ({ id, result: "pass", artifact: artifact.relPath, observedAt: now })),
    ...overrides,
  };
  const manifestPath = join(evidenceRoot, runbook, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(record, null, 2), "utf8");
  return `${runbook}/manifest.json`;
}

function writeSubmissionIndex(evidenceRoot: string, paths: string[]): void {
  writeFileSync(
    join(evidenceRoot, SUBMISSION_INDEX_FILENAME),
    `${JSON.stringify({ format: SUBMISSION_INDEX_FORMAT, submittedManifests: paths }, null, 2)}\n`,
    "utf8",
  );
}

describe("production-ops-evidence", () => {
  describe("--self-test", () => {
    it("exits 0 and reports all cases pass, including the six required categories", () => {
      const result = runGate(["--self-test"]);
      expect(result.status).toBe(0);
      const jsonLine = result.stdout.trim().split("\n").find((l) => l.startsWith("{")) ?? "";
      const parsed = JSON.parse(jsonLine) as { selfTest: boolean; pass: boolean; checks: Record<string, boolean> };
      expect(parsed.selfTest).toBe(true);
      expect(parsed.pass).toBe(true);
      expect(parsed.checks.case1_allPassBesideUnrelatedJson).toBe(true);
      expect(parsed.checks.case2_noManifestsError).toBe(true);
      expect(parsed.checks.case3a_unsupportedRunbookFails).toBe(true);
      expect(parsed.checks.case3b_wrongFormatVersionFails).toBe(true);
      expect(parsed.checks.case3c_selfTestClaimBlocked).toBe(true);
      expect(parsed.checks.case4_missingAssertionsFails).toBe(true);
      expect(parsed.checks.case5_tamperedArtifactFails).toBe(true);
      expect(parsed.checks.case5b_missingListedManifestFails).toBe(true);
      expect(parsed.checks.case6a_syntheticRejected).toBe(true);
      expect(parsed.checks.case6b_localTargetRejected).toBe(true);
    });
  });

  describe("verify — the real ops:evidence:check entry point", () => {
    let workspaceRoot: string;
    let evidenceRoot: string;
    let cleanup: () => void;

    beforeEach(() => {
      ({ workspaceRoot, evidenceRoot, cleanup } = makeWorkspace());
    });

    afterEach(() => {
      cleanup();
    });

    it("case 1: passes with valid RB-01..08 manifests beside unrelated JSON and an unlisted format-bearing JSON", () => {
      const manifestPaths: string[] = [];
      for (const rb of RUNBOOKS) manifestPaths.push(writeManifest(evidenceRoot, rb));
      writeFileSync(join(evidenceRoot, "raw-measurements.json"), JSON.stringify({ generatedAt: new Date().toISOString(), counts: [1, 2, 3] }), "utf8");
      writeFileSync(join(evidenceRoot, "unlisted-ops-format.json"), JSON.stringify({ format: FORMAT, runbook: "RB-99" }), "utf8");
      writeSubmissionIndex(evidenceRoot, manifestPaths);
      const result = runGate(["verify"], { STREAMLINE_WORKSPACE_ROOT: workspaceRoot });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("PRODUCTION OPS EVIDENCE GATE PASS");
      expect(result.stdout).toContain("a parseable operator name/timestamp is not authentication of a human approval");
    });

    it("case 2: exits 1 when no submission index exists", () => {
      writeFileSync(join(evidenceRoot, "artifact-hashes.json"), JSON.stringify({ covers: ["foo"] }), "utf8");
      const result = runGate(["verify"], { STREAMLINE_WORKSPACE_ROOT: workspaceRoot });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("no submitted evidence manifests found");
    });

    it("case 2b: exits 1 when submission index has empty list", () => {
      writeSubmissionIndex(evidenceRoot, []);
      const result = runGate(["verify"], { STREAMLINE_WORKSPACE_ROOT: workspaceRoot });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("no submitted evidence manifests found");
    });

    it("case 3: exits 1 for a selected manifest with unsupported runbook", () => {
      writeFileSync(join(evidenceRoot, "bad-runbook.json"), JSON.stringify({ format: FORMAT, runbook: "RB-99" }), "utf8");
      writeSubmissionIndex(evidenceRoot, ["bad-runbook.json"]);
      const result = runGate(["verify"], { STREAMLINE_WORKSPACE_ROOT: workspaceRoot });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("unsupported runbook RB-99");
    });

    it("case 3b: exits 1 for a selected manifest with wrong format version", () => {
      writeFileSync(join(evidenceRoot, "old-version.json"), JSON.stringify({ format: "streamlineos.production-ops-evidence/v0", runbook: "RB-01" }), "utf8");
      writeSubmissionIndex(evidenceRoot, ["old-version.json"]);
      const result = runGate(["verify"], { STREAMLINE_WORKSPACE_ROOT: workspaceRoot });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("wrong or missing evidence format");
    });

    it("case 4: exits 1 when a selected manifest has failed or missing assertions", () => {
      const path = writeManifest(evidenceRoot, "RB-01");
      const manifestPath = join(evidenceRoot, "RB-01", "manifest.json");
      const record = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      writeFileSync(manifestPath, JSON.stringify({ ...record, assertions: [] }, null, 2), "utf8");
      writeSubmissionIndex(evidenceRoot, [path]);
      const result = runGate(["verify"], { STREAMLINE_WORKSPACE_ROOT: workspaceRoot });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("required assertion is not a pass:");
    });

    it("case 5: exits 1 when a selected manifest references a tampered artifact", () => {
      const path = writeManifest(evidenceRoot, "RB-02");
      const artifactPath = join(evidenceRoot, "RB-02", "output.txt");
      writeFileSync(artifactPath, "tampered content that changes the hash\n", "utf8");
      writeSubmissionIndex(evidenceRoot, [path]);
      const result = runGate(["verify"], { STREAMLINE_WORKSPACE_ROOT: workspaceRoot });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("artifact hash does not match");
    });

    it("case 5b: exits 1 when the submission index lists a manifest that does not exist on disk", () => {
      writeSubmissionIndex(evidenceRoot, ["RB-02/manifest.json"]);
      const result = runGate(["verify"], { STREAMLINE_WORKSPACE_ROOT: workspaceRoot });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("listed manifest does not exist");
    });

    it("case 6a: exits 1 and rejects synthetic evidence even when explicitly listed", () => {
      const path = writeManifest(evidenceRoot, "RB-03", { synthetic: true });
      writeSubmissionIndex(evidenceRoot, [path]);
      const result = runGate(["verify"], { STREAMLINE_WORKSPACE_ROOT: workspaceRoot });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("evidence must declare live=true and synthetic must not be true");
    });

    it("case 6b: exits 1 and rejects local-environment evidence even when explicitly listed", () => {
      const path = writeManifest(evidenceRoot, "RB-04", {
        environment: { name: "dev-local", region: "local", cell: "local-01", target: "http://localhost:3000" },
      });
      writeSubmissionIndex(evidenceRoot, [path]);
      const result = runGate(["verify"], { STREAMLINE_WORKSPACE_ROOT: workspaceRoot });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PRODUCTION OPS EVIDENCE GATE FAILED");
    });
  });
});
