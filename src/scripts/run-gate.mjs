#!/usr/bin/env node
/**
 * Run one gate and tell a MISSING PREREQUISITE apart from a REAL FINDING.
 *
 * Written 2026-09-03 for v2 ticket 30 (PRD-C011/C015/C104).
 *
 * Every cross-repository gate in this project already distinguishes the two by exit code:
 *   0  the rule was checked and holds
 *   1  the rule was checked and is VIOLATED — a real finding
 *   2  the rule could not be checked — INCONCLUSIVE, a named prerequisite is absent
 *      (see check-repo-paths.mjs `reportBackendUnreachable`)
 *
 * CI threw that distinction away. Eight frontend and ten backend steps carried
 * `continue-on-error: true`, which swallows 1 and 2 identically: the job goes green, the red is
 * a grey annotation, and a genuine violation can be merged straight past. Measured at head:
 * six of those gates exit 2 in the single-repository checkout CI performs and 1 when they find
 * a defect, and no one could have told which had happened from the job status.
 *
 * This runner keeps the tolerance and restores the bite. Exit 2 becomes a visible GitHub
 * warning annotation and a passing step; every other non-zero code fails the step, and the job.
 *
 * It is deliberately Node and not a shell snippet. PRD-C015 requires the harness to run on
 * Windows, macOS and Linux; `set +e ... $?` is bash-only and silently mis-reports under
 * PowerShell, which is the default shell on a windows-latest runner.
 *
 * Usage:
 *   node src/scripts/run-gate.mjs <package-script> [more-scripts...] --prerequisite "<what is absent>"
 *   node src/scripts/run-gate.mjs --self-test
 *
 * Multiple scripts run in order and stop at the first failure, so it composes the
 * `<gate>:self-test && <gate>` pairing the workflows already use.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const INCONCLUSIVE = 2;

/** Text a CI log can be grepped for; GitHub renders `::warning` as an annotation. */
export function annotation(script, prerequisite) {
  return (
    `::warning title=INCONCLUSIVE::${script} exited ${INCONCLUSIVE} — ` +
    `${prerequisite}. The rule was NOT checked, so this run proves nothing about it. ` +
    "This step passes only because the prerequisite is absent, never because the gate was satisfied."
  );
}

/**
 * The whole decision, as a pure function so the self-test can assert it without spawning.
 * Returns { exit, warn } — `warn` is the annotation text, or null.
 */
export function decide(code, script, prerequisite) {
  if (code === 0) return { exit: 0, warn: null };
  if (code === INCONCLUSIVE) return { exit: 0, warn: annotation(script, prerequisite) };
  return { exit: code, warn: null };
}

export function parseArgs(argv) {
  const scripts = [];
  let prerequisite = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--prerequisite") {
      prerequisite = argv[++i] ?? null;
      continue;
    }
    scripts.push(argv[i]);
  }
  return { scripts, prerequisite };
}

function runSelfTest() {
  const failures = [];
  let passed = 0;
  const assert = (label, condition) => {
    if (condition) passed++;
    else failures.push(label);
  };

  assert("exit 0 passes and warns about nothing", (() => {
    const r = decide(0, "check:x", "a sibling checkout is absent");
    return r.exit === 0 && r.warn === null;
  })());

  // The whole point. These two used to be indistinguishable under continue-on-error.
  assert("exit 1 — a REAL FINDING — still fails the step", decide(1, "check:x", "p").exit === 1);
  assert("exit 2 — a missing prerequisite — passes the step", decide(2, "check:x", "p").exit === 0);
  assert("exit 2 emits a warning annotation", decide(2, "check:x", "p").warn !== null);
  assert("exit 1 emits NO annotation, so a finding cannot read as inconclusive", decide(1, "check:x", "p").warn === null);
  assert(
    "the annotation names the gate and the absent prerequisite",
    (() => {
      const w = decide(2, "check:module-manifest", "a backend checkout is absent").warn ?? "";
      return w.includes("check:module-manifest") && w.includes("a backend checkout is absent");
    })(),
  );
  assert(
    "the annotation states that passing is not the same as satisfied",
    (decide(2, "check:x", "p").warn ?? "").includes("never because the gate was satisfied"),
  );

  // Other non-zero codes are findings too. A gate that crashes (exit 1 from an uncaught
  // throw), is killed (137), or aborts (134) must not be laundered into a pass.
  for (const code of [3, 7, 127, 134, 137, 255])
    assert(`exit ${code} fails the step`, decide(code, "check:x", "p").exit === code);

  assert(
    "argument parsing keeps script order and lifts --prerequisite out",
    (() => {
      const { scripts, prerequisite } = parseArgs(["check:a:self-test", "check:a", "--prerequisite", "why"]);
      return scripts.length === 2 && scripts[0] === "check:a:self-test" && scripts[1] === "check:a" && prerequisite === "why";
    })(),
  );
  assert(
    "a missing --prerequisite value does not silently become a script name",
    parseArgs(["check:a", "--prerequisite"]).scripts.length === 1,
  );

  if (failures.length > 0) {
    for (const f of failures) console.error(`  FAIL: ${f}`);
    console.error(`run-gate self-tests: ${failures.length} failed, ${passed} passed`);
    process.exit(1);
  }
  console.log(`run-gate self-tests: ${passed} passed`);
  process.exit(0);
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) runSelfTest();

  const { scripts, prerequisite } = parseArgs(argv);
  if (scripts.length === 0) {
    console.error("run-gate: name at least one package script to run.");
    process.exit(1);
  }
  if (prerequisite === null) {
    console.error(
      "run-gate: --prerequisite is required. It names what must be present for the gate to be " +
        "conclusive, and it is printed when the gate reports it is not. A runner that tolerates " +
        "exit 2 without saying what was missing is the vagueness this replaces.",
    );
    process.exit(1);
  }

  for (const script of scripts) {
    const result = spawnSync("pnpm", ["run", script], { stdio: "inherit", shell: process.platform === "win32" });
    if (result.error !== undefined && result.error !== null) {
      console.error(`run-gate: could not start "pnpm run ${script}" — ${result.error.message}`);
      process.exit(1);
    }
    // A signal death has a null status. It is a failure, never a pass.
    const code = result.status === null ? 1 : result.status;
    const { exit, warn } = decide(code, script, prerequisite);
    if (warn !== null) console.log(warn);
    if (exit !== 0) process.exit(exit);
    if (warn !== null) break;
  }
  process.exit(0);
}
