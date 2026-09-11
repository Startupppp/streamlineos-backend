/**
 * The redaction half of PRD-C188 ("store a **redacted**, hashed evidence bundle").
 *
 * `check:evidence-seal` proves the bundle is *hashed*. Until `check-evidence-redaction.mjs`
 * existed, nothing proved it was *redacted*: the only statement to that effect was a
 * sentence the bundle wrote about itself ("scanned before sealing … zero matches"), never
 * re-run as the bundle grew. This spec is what keeps that gate honest.
 *
 * Every assertion spawns the SHIPPED script rather than importing it — the module calls
 * `process.exit()` at top level, so importing it would kill the jest worker, and spawning
 * means what is measured is the artifact the npm gate runs.
 *
 * The fixture trees are built to clear the gate's own corpus floors on purpose. A tree that
 * cannot reach the floor exits 2, and one of the tests below pins exactly that: a gate that
 * scanned four files must not be able to say "clean".
 *
 *   npx jest --testPathPattern="evidence-redaction-gate"
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

jest.setTimeout(120_000);

const BACKEND_ROOT = resolve(__dirname, "../..");
const GATE = resolve(BACKEND_ROOT, "src/scripts/check-evidence-redaction.mjs");

interface GateRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runGate(args: readonly string[]): GateRun {
  try {
    const stdout = execFileSync(process.execPath, [GATE, ...args], {
      cwd: BACKEND_ROOT,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=1024" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

/**
 * The credential shapes are assembled from fragments so this spec file itself never
 * contains a literal that would make the gate red if the spec were ever copied into the
 * evidence tree.
 */
const AWS_KEY = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const URL_WITH_PASSWORD = ["postgres://role", "hunter2secret@db.internal/app"].join(":");
const REAL_EMAIL = ["person.name", "a-real-company.co.uk"].join("@");
const MANAGED_HOST = ["ep-quiet-frost-123456.us-east-2.aws", "neon", "tech"].join(".");

let dir: string;

/** A fixture bundle that clears MIN_FILES_SCANNED and MIN_BYTES_SCANNED. */
function makeBundle(extraFiles: Readonly<Record<string, string>> = {}): string {
  const bundle = join(dir, `bundle-${Math.random().toString(36).slice(2)}`);
  mkdirSync(bundle, { recursive: true });
  const hashes: Record<string, string> = {};
  const filler = "verbatim drill transcript line for drill+ab12@compliance-synthetic.invalid\n".repeat(60);
  for (let i = 0; i < 50; i++) {
    const name = `run-${String(i).padStart(2, "0")}.txt`;
    writeFileSync(join(bundle, name), filler, "utf8");
    hashes[name] = "not-verified-by-this-gate";
  }
  for (const [name, body] of Object.entries(extraFiles)) {
    writeFileSync(join(bundle, name), body, "utf8");
    hashes[name] = "not-verified-by-this-gate";
  }
  writeFileSync(join(bundle, "artifact-hashes.json"), JSON.stringify({ fileCount: Object.keys(hashes).length, hashes }), "utf8");
  return bundle;
}

/** A second seal, because the gate refuses a tree carrying fewer than MIN_SEALS. */
function makeRoot(extraFiles: Readonly<Record<string, string>> = {}): string {
  const root = mkdtempSync(join(dir, "root-"));
  const a = join(root, "a");
  const b = join(root, "b");
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  const filler = "line for user-100@scratch-seed.test\n".repeat(80);
  for (const [target, extras] of [
    [a, extraFiles],
    [b, {}],
  ] as const) {
    const hashes: Record<string, string> = {};
    for (let i = 0; i < 30; i++) {
      const name = `f-${String(i).padStart(2, "0")}.txt`;
      writeFileSync(join(target, name), filler, "utf8");
      hashes[name] = "not-verified-by-this-gate";
    }
    for (const [name, body] of Object.entries(extras)) {
      writeFileSync(join(target, name), body, "utf8");
      hashes[name] = "not-verified-by-this-gate";
    }
    writeFileSync(join(target, "artifact-hashes.json"), JSON.stringify({ fileCount: Object.keys(hashes).length, hashes }), "utf8");
  }
  return root;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "evidence-redaction-spec-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("check-evidence-redaction gate", () => {
  it("passes its own self-test, controls and bite proofs included", () => {
    const run = runGate(["--self-test"]);
    expect(run.status).toBe(0);
    const report = JSON.parse(run.stdout) as { pass: boolean; checks: Record<string, boolean> };
    expect(report.pass).toBe(true);
    for (const [name, ok] of Object.entries(report.checks)) expect([name, ok]).toEqual([name, true]);
  });

  it("reports a clean fixture bundle as clean", () => {
    const run = runGate([`--root=${makeRoot()}`]);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("OK — no credential");
  });

  /* THE BITE. Each of these is a leak the gate must refuse to call clean. */

  it("fails on a credential planted in a SEALED file", () => {
    const run = runGate([`--root=${makeRoot({ "leak.txt": `token=${AWS_KEY}\n` })}`]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("aws-access-key-id");
  });

  it("fails on a credential planted in an UNSEALED file inside a sealed directory", () => {
    const root = makeRoot();
    writeFileSync(join(root, "a", "not-in-the-seal.txt"), `token=${AWS_KEY}\n`, "utf8");
    const run = runGate([`--root=${root}`]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("not-in-the-seal.txt");
  });

  it("fails on a real person's e-mail address", () => {
    const run = runGate([`--root=${makeRoot({ "who.txt": `reported by ${REAL_EMAIL}\n` })}`]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("non-synthetic-email");
  });

  it("fails on a connection string carrying a real password", () => {
    const run = runGate([`--root=${makeRoot({ "conn.txt": `${URL_WITH_PASSWORD}\n` })}`]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("password-in-url");
  });

  it("fails on a managed database host name", () => {
    const run = runGate([`--root=${makeRoot({ "host.txt": `${MANAGED_HOST}\n` })}`]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("managed-host-name");
  });

  /* THE OTHER HALF OF THE BITE. A gate that fires on everything is unusable, so the
     redaction the bundle actually uses must stay green. */

  it("accepts an already-redacted connection string and a reserved-TLD address", () => {
    const run = runGate([
      `--root=${makeRoot({
        "conn.txt": "postgres://<db-role>:***@<neon-host>/scratch_boot_b?sslmode=require\n",
        "who.txt": "drill+ab12@compliance-synthetic.invalid and user-100@scratch-seed.test\n",
        "vendor.txt": `the remote Neon host ${["neon", "tech"].join(".")} was never contacted\n`,
      })}`,
    ]);
    expect(run.status).toBe(0);
  });

  /* ANTI-VACUITY. A corpus too small to mean anything must be INCONCLUSIVE, not clean. */

  it("refuses to pass a tree with too few seals", () => {
    const root = mkdtempSync(join(dir, "oneseal-"));
    const only = join(root, "only");
    mkdirSync(only, { recursive: true });
    writeFileSync(join(only, "artifact-hashes.json"), JSON.stringify({ hashes: {} }), "utf8");
    const run = runGate([`--root=${root}`]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("seal(s) found");
  });

  it("refuses to pass a tree below the file floor", () => {
    const root = mkdtempSync(join(dir, "tiny-"));
    for (const name of ["a", "b"]) {
      const d = join(root, name);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "one.txt"), "clean\n", "utf8");
      writeFileSync(join(d, "artifact-hashes.json"), JSON.stringify({ hashes: { "one.txt": "x" } }), "utf8");
    }
    const run = runGate([`--root=${root}`]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("file(s) in the corpus");
  });

  it("refuses to pass a tree below the byte floor", () => {
    const root = mkdtempSync(join(dir, "thin-"));
    for (const name of ["a", "b"]) {
      const d = join(root, name);
      mkdirSync(d, { recursive: true });
      const hashes: Record<string, string> = {};
      for (let i = 0; i < 30; i++) {
        const f = `f-${i}.txt`;
        writeFileSync(join(d, f), "x\n", "utf8");
        hashes[f] = "x";
      }
      writeFileSync(join(d, "artifact-hashes.json"), JSON.stringify({ hashes }), "utf8");
    }
    const run = runGate([`--root=${root}`]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("byte(s) were scanned");
  });

  it("declares its floors and patterns without touching the disk", () => {
    const run = runGate(["--print-config"]);
    expect(run.status).toBe(0);
    const config = JSON.parse(run.stdout) as {
      patterns: string[];
      floors: { minSeals: number; minFilesScanned: number; minBytesScanned: number; minPatterns: number };
    };
    expect(config.patterns.length).toBeGreaterThanOrEqual(config.floors.minPatterns);
    expect(config.floors.minSeals).toBeGreaterThan(0);
    expect(config.floors.minFilesScanned).toBeGreaterThan(0);
    expect(config.floors.minBytesScanned).toBeGreaterThan(0);
    expect(config.patterns).toEqual(expect.arrayContaining(["non-synthetic-email", "password-in-url"]));
  });

  /* AND THE REAL THING. Fixtures prove the mechanism; this proves it is pointed at the
     shipped bundle and that the shipped bundle is actually clean. */

  it("scans the real release evidence tree and finds it redacted", () => {
    const run = runGate([]);
    expect(run.status).toBe(0);
    const scanned = /(\d+) seal\(s\) · (\d+) file\(s\) · (\d+) bytes/.exec(run.stdout);
    expect(scanned).not.toBeNull();
    expect(Number(scanned?.[1])).toBeGreaterThanOrEqual(2);
    expect(Number(scanned?.[2])).toBeGreaterThanOrEqual(40);
    expect(Number(scanned?.[3])).toBeGreaterThanOrEqual(100_000);
    expect(run.stdout).toContain("0 leak(s)");
    expect(run.stdout).toContain("0 stale exemption(s)");
  });
});
