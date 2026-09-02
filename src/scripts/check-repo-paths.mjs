/**
 * Shared repository-root resolution for the backend `check:*` gates.
 *
 * A gate that hardcodes `<backend>/../frontend` dies with ENOENT on any
 * checkout where the two repositories are siblings named something else, and a
 * gate that swallows that ENOENT reports a green tick for a comparison that
 * never ran. This searches upward for a directory carrying the marker instead
 * of guessing a relative depth, and treats an explicit override as
 * authoritative so a wrong override fails loudly rather than silently
 * resolving elsewhere.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));

const FRONTEND_MARKER = join("lib", "rbac", "permissions");
const FRONTEND_SIBLINGS = ["frontend", join("streamlineos-frontend", "frontend")];

const WORKSPACE_MARKER = join("architecture-refactor", "final-refactor", "issues");
const WORKSPACE_SIBLINGS = [".", "streamlineos-frontend"];

function resolveRoot(marker, siblings, envName) {
  const override = process.env[envName];
  if (override) {
    const abs = resolve(override);
    return { root: existsSync(join(abs, marker)) ? abs : null, overridden: true, marker, envName };
  }
  let dir = SCRIPT_DIR;
  for (let depth = 0; depth < 8; depth++) {
    for (const name of siblings) {
      const candidate = resolve(dir, name);
      if (existsSync(join(candidate, marker))) return { root: candidate, overridden: false, marker, envName };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { root: null, overridden: false, marker, envName };
}

const frontend = resolveRoot(FRONTEND_MARKER, FRONTEND_SIBLINGS, "STREAMLINE_FRONTEND_ROOT");
const workspace = resolveRoot(WORKSPACE_MARKER, WORKSPACE_SIBLINGS, "STREAMLINE_WORKSPACE_ROOT");

function reason(state) {
  if (state.overridden)
    return `${state.envName} is set to "${String(process.env[state.envName])}" but that directory does not contain ${state.marker}.`;
  return `Not found. Searched for a directory containing ${state.marker} beside or above ${SCRIPT_DIR}. Set ${state.envName} to override.`;
}

export const FRONTEND_ROOT = frontend.root;
export const frontendAvailable = frontend.root !== null;
export const frontendUnreachableReason = () => reason(frontend);

export function frontendPath(...segments) {
  if (FRONTEND_ROOT === null) throw new Error(frontendUnreachableReason());
  return join(FRONTEND_ROOT, ...segments);
}

export const WORKSPACE_ROOT = workspace.root;
export const workspaceAvailable = workspace.root !== null;
export const workspaceUnreachableReason = () => reason(workspace);

export function workspacePath(...segments) {
  if (WORKSPACE_ROOT === null) throw new Error(workspaceUnreachableReason());
  return join(WORKSPACE_ROOT, ...segments);
}

/**
 * A gate that cannot reach the other repository must say INCONCLUSIVE and exit
 * non-zero unless the operator explicitly opted into a partial run.
 */
export function reportUnreachable(gateName, whatIsSkipped, why) {
  const allowed = process.env.STREAMLINE_ALLOW_PARTIAL_GATES === "1";
  const stream = allowed ? console.warn : console.error;
  stream(`${allowed ? "PARTIAL" : "INCONCLUSIVE"} — ${gateName}: ${whatIsSkipped} could not run.`);
  stream(`  ${why}`);
  if (allowed) {
    console.warn("  STREAMLINE_ALLOW_PARTIAL_GATES=1 — downgraded to PARTIAL; this run proves nothing about the skipped rule.");
    return;
  }
  console.error("  Set the root override, or set STREAMLINE_ALLOW_PARTIAL_GATES=1 to accept a PARTIAL run.");
  process.exit(2);
}

export function runSelfTest() {
  let passed = 0;
  const failures = [];
  const assert = (label, condition) => {
    if (condition) passed++;
    else failures.push(label);
  };

  assert("frontend root resolves in this checkout", frontendAvailable);
  assert(
    "frontend root actually carries the marker",
    frontendAvailable && existsSync(join(FRONTEND_ROOT, FRONTEND_MARKER)),
  );
  assert("workspace root resolves in this checkout", workspaceAvailable);
  assert(
    "workspace root actually carries the marker",
    workspaceAvailable && existsSync(join(WORKSPACE_ROOT, WORKSPACE_MARKER)),
  );

  const bogus = resolveRoot(FRONTEND_MARKER, FRONTEND_SIBLINGS, "STREAMLINE_SELFTEST_ABSENT_MARKER");
  assert("a marker that exists still resolves without an override", bogus.root !== null);

  const missing = resolveRoot(join("no", "such", "marker"), FRONTEND_SIBLINGS, "STREAMLINE_SELFTEST_NO_MARKER");
  assert("an unfindable marker resolves to null rather than a wrong directory", missing.root === null);
  assert("an unfindable marker produces a reason naming the marker", reason(missing).includes("no"));

  const previous = process.env.STREAMLINE_SELFTEST_OVERRIDE;
  process.env.STREAMLINE_SELFTEST_OVERRIDE = join(SCRIPT_DIR, "definitely-not-a-repo");
  const badOverride = resolveRoot(FRONTEND_MARKER, FRONTEND_SIBLINGS, "STREAMLINE_SELFTEST_OVERRIDE");
  if (previous === undefined) delete process.env.STREAMLINE_SELFTEST_OVERRIDE;
  else process.env.STREAMLINE_SELFTEST_OVERRIDE = previous;
  assert("a wrong override fails loudly instead of falling back to the search", badOverride.root === null);
  assert("a wrong override is reported as an override problem", badOverride.overridden === true);

  if (failures.length > 0) {
    for (const f of failures) console.error(`  FAIL: ${f}`);
    console.error(`check-repo-paths self-tests: ${failures.length} failed, ${passed} passed`);
    process.exit(1);
  }
  console.log(`check-repo-paths self-tests: ${passed} passed`);
  process.exit(0);
}

// Only when this module is the entry point. An importing gate passing
// --self-test must run its own self-test, not have this one exit(0) under it.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly && process.argv.includes("--self-test")) runSelfTest();
