import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * T20 — a gate an unrelated failure can switch off is not a gate.
 *
 * `ci.yml` used to run everything in one job called `verify`, in this order:
 * Typecheck, **Lint**, **Test**, Build, then thirty `check:*` gates. Lint is red
 * with errors inherited from `main` and out of scope for the inventory
 * programme. In run 33489746534 it failed at step 7 and steps 8-37 — Test and
 * every gate below it — reported `skipped`. So every inventory ratchet this
 * programme built was silenced by somebody else's lint error, and none of them
 * had ever executed in CI even once.
 *
 * T20 answered that with a `lint` job, a `test` job and an `inventory-ratchets`
 * job that named five suites through `--testPathPattern`. `main` answered the
 * same defect with a different split — `verify` (build health only), `tests`
 * (the whole unfiltered suite), `gates` (every static gate) — and that split
 * wins here, because it is strictly wider on both halves:
 *
 *   - `tests` runs `pnpm test` with NO filter. A `--testPathPattern` job reports
 *     green for every suite outside its own pattern, so naming five ratchets
 *     protected five suites and left the rest where they were. Unfiltered
 *     protects all of them, the five included.
 *   - every step in `gates` carries `if: ${{ !cancelled() }}`, which is the
 *     within-job half of the same masking defect: without it one red gate skips
 *     all of its successors and the job reports on a prefix.
 *
 * So this spec asserts the property rather than T20's job names: Lint cannot
 * fail Test, no job waits on another, the test run is unfiltered, no gate hides
 * its successors, and the five ratchet files are still on disk under a root the
 * unfiltered run reaches.
 *
 * Deliberately parsed as TEXT, not YAML. There is no YAML parser in this
 * repository's dependencies, and adding one to assert six properties of one
 * file is a worse trade than a small indentation walk — `ci.yml` is
 * two-space-indented GitHub Actions, not arbitrary YAML.
 */

const ROOT = resolve(process.cwd());
const CI = resolve(ROOT, ".github", "workflows", "ci.yml");
const src = readFileSync(CI, "utf8");

/** Everything from a top-level `jobs:` key down to the next one, keyed by job id. */
const jobs = ((): ReadonlyMap<string, string> => {
  const out = new Map<string, string>();
  const body = src.slice(src.indexOf("\njobs:\n"));
  const lines = body.split("\n");
  let current: string | null = null;
  let buffer: string[] = [];
  for (const line of lines) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      if (current) out.set(current, buffer.join("\n"));
      current = header[1] ?? null;
      buffer = [];
      continue;
    }
    if (current) buffer.push(line);
  }
  if (current) out.set(current, buffer.join("\n"));
  return out;
})();

const stepNames = (job: string): string[] =>
  [...(jobs.get(job) ?? "").matchAll(/^ {6}- name: (.+)$/gm)].map((m) => (m[1] ?? "").trim());

/** Steps of a job, each as its whole block, so a step's own `if:` travels with it. */
const stepBlocks = (job: string): string[] => (jobs.get(job) ?? "").split(/^ {6}- name: /m).slice(1);

/** The unfiltered test run, and the job that must own it on its own. */
const TEST_JOB = "tests";
const LINT_JOB = "verify";

describe("T20 — CI jobs that must not be able to silence each other", () => {
  it("finds the workflow and its jobs, so a rewritten file cannot pass vacuously", () => {
    expect(src.length).toBeGreaterThan(5000);
    // The walk itself has to have worked. A broken parser returning nothing is
    // exactly the shape of failure every assertion below would read as a pass.
    expect(jobs.size).toBeGreaterThanOrEqual(6);
    for (const id of [LINT_JOB, TEST_JOB, "gates"]) expect([...jobs.keys()]).toContain(id);
  });

  it("keeps Lint and Test in different jobs", () => {
    // The defect, stated directly: Lint above Test in one job means a red Lint
    // reports Test as `skipped`.
    expect(stepNames(LINT_JOB)).toContain("Lint");
    expect(stepNames(TEST_JOB)).toContain("Test");
    expect(stepNames(LINT_JOB)).not.toContain("Test");
    expect(stepNames(TEST_JOB)).not.toContain("Lint");
    // And the gates are a third job, so Lint cannot skip them either.
    expect(stepNames("gates")).not.toContain("Lint");
    expect(stepNames("gates")).not.toContain("Test");
  });

  it("gives no job a `needs:`, or the dependency restores the mask", () => {
    // Every job, not a named few: a `needs:` added to a job this spec did not
    // think to list reinstates exactly the failure T20 removed.
    for (const [id, body] of jobs) expect(`${id}: ${body}`).not.toMatch(/^\s{4}needs:/m);
  });

  it("runs the suite unfiltered, so no ratchet can be outside the pattern", () => {
    const body = jobs.get(TEST_JOB) ?? "";
    const commands = body
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");

    expect(commands).toContain("pnpm test");
    // A filter is what made five named ratchets the only protected suites. Both
    // of these turn a renamed or moved spec into a silent green.
    expect(commands).not.toContain("--testPathPattern");
    expect(commands).not.toContain("--passWithNoTests");
  });

  it("keeps the inventory ratchets on disk, under a root the unfiltered run reaches", () => {
    // The workflow no longer names them, so this is where a rename stops being
    // invisible. `.db.spec.ts` is excluded from the default jest project on
    // purpose and runs in `db-gates.yml`, so no ratchet here may carry it.
    const ratchets = [
      "src/modules/inventory/__tests__/inventory-reachability.spec.ts",
      "src/modules/inventory/__tests__/inventory-schema-reachability.spec.ts",
      "src/modules/inventory/stock-engine/__tests__/available-formula-single-definition.spec.ts",
      "src/modules/inventory/__tests__/idempotent-guard-placement.spec.ts",
      "src/db/cold-build-integrity.spec.ts",
    ];
    expect(ratchets.length).toBeGreaterThanOrEqual(5);
    for (const file of ratchets) {
      expect(existsSync(resolve(ROOT, file))).toBe(true);
      expect(file.startsWith("src/")).toBe(true);
      expect(file.endsWith(".db.spec.ts")).toBe(false);
    }
  });

  it("lets no gate step skip the gates below it", () => {
    // The within-job half of the same defect: measured on run 33622305895, one
    // red step turned 30 gates into "-". `if: ${{ !cancelled() }}` does not
    // weaken anything — a failed step without `continue-on-error` still fails
    // the job, it simply stops hiding its successors.
    const steps = stepBlocks("gates");
    expect(steps.length).toBeGreaterThanOrEqual(30);
    const unguarded = steps
      .filter((step) => !step.includes("!cancelled()"))
      .map((step) => (step.split("\n")[0] ?? "").trim());
    expect(unguarded).toEqual([]);
  });

  it("triggers on a push to a feature branch, not only on a mergeable PR", () => {
    // `pull_request` is raised from the PR's merge commit and stops being raised
    // once the PR conflicts with its base. That is what took CI off this branch
    // on 2026-09-01: `refs/pull/16/merge` last written 08:57:59Z, last
    // `pull_request` run started 08:58:01Z, then nothing for a dozen pushes.
    const trigger = src.slice(src.indexOf("\non:\n"), src.indexOf("\nconcurrency:"));
    expect(trigger).toContain("push:");
    expect(trigger).toMatch(/branches:\s*\[main,\s*"feat\/\*\*"\]/);
  });
});
