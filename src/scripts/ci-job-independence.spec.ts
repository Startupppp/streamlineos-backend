import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * T20 — a gate an unrelated failure can switch off is not a gate.
 *
 * `ci.yml` used to run everything in one job called `verify`, in this order:
 * Typecheck, **Lint**, **Test**, Build, then thirty `check:*` gates. Lint is red
 * with 244 errors inherited from `main` and out of scope for the inventory
 * programme. In run 33489746534 it failed at step 7 and steps 8-37 — Test and
 * every gate below it — reported `skipped`. So every inventory ratchet this
 * programme built was silenced by somebody else's lint error, and none of them
 * had ever executed in CI even once.
 *
 * Lint, Test and the named inventory ratchets are separate jobs now, each with
 * no `needs:`. This asserts that shape, because the failure it prevents is
 * invisible: re-merging them would go green on the day it landed and only cost
 * something the next time lint broke.
 *
 * Deliberately parsed as TEXT, not YAML. There is no YAML parser in this
 * repository's dependencies, and adding one to assert five properties of one
 * file is a worse trade than a small indentation walk — `ci.yml` is
 * two-space-indented GitHub Actions, not arbitrary YAML.
 */

const CI = resolve(process.cwd(), ".github", "workflows", "ci.yml");
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

describe("T20 — CI jobs that must not be able to silence each other", () => {
  it("finds the workflow and its jobs, so a rewritten file cannot pass vacuously", () => {
    expect(src.length).toBeGreaterThan(5000);
    // The walk itself has to have worked. A broken parser returning nothing is
    // exactly the shape of failure every assertion below would read as a pass.
    expect(jobs.size).toBeGreaterThanOrEqual(6);
    for (const id of ["lint", "test", "inventory-ratchets", "verify"])
      expect([...jobs.keys()]).toContain(id);
  });

  it("keeps Lint and Test in different jobs", () => {
    // The defect, stated directly: Lint above Test in one job means a red Lint
    // reports Test as `skipped`.
    expect(stepNames("lint")).toContain("Lint");
    expect(stepNames("test")).toContain("Test");
    expect(stepNames("verify")).not.toContain("Lint");
    expect(stepNames("verify")).not.toContain("Test");
  });

  it("gives the independent jobs no `needs:`, or the dependency restores the mask", () => {
    for (const id of ["lint", "test", "inventory-ratchets", "verify"])
      expect(jobs.get(id) ?? "").not.toMatch(/^\s{4}needs:/m);
  });

  it("runs the inventory ratchets by name, and asserts every one of their files exists", () => {
    const body = jobs.get("inventory-ratchets") ?? "";
    const ratchets = stepNames("inventory-ratchets").filter((n) => n.startsWith("Ratchet - "));
    // A floor, not an exact count: other lanes add ratchets to this job and should
    // not have to edit this spec to do it. Five is the set T20 put there, and each
    // is named below, so the floor cannot be met by five of something else.
    expect(ratchets.length).toBeGreaterThanOrEqual(5);
    for (const name of [
      "inventory-reachability",
      "inventory-schema-reachability",
      "available-formula",
      "idempotent-guard-placement",
      "cold-build-integrity",
    ])
      expect(ratchets).toContain(`Ratchet - ${name}`);

    // `--passWithNoTests` would turn a renamed spec into a silent green. Without
    // it, `jest --ci --testPathPattern=<gone>` exits 1. Checked on the commands
    // only — the job's own comment names the flag it must not use.
    const commands = body
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    expect(commands).toContain("--ci --testPathPattern");
    expect(commands).not.toContain("--passWithNoTests");

    // And every ratchet step has a file the job asserts is present, so adding a
    // ratchet without its existence check — the way a rename becomes invisible —
    // fails here rather than a year later.
    expect(body).toContain("MISSING RATCHET");
    const existenceCheck = body.slice(body.indexOf("ratchets exist"));
    const asserted = new Set(
      [...existenceCheck.matchAll(/src\/[^\s"';]+\.spec\.ts/g)].map((m) => m[0]),
    );
    expect(asserted.size).toBe(ratchets.length);
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
