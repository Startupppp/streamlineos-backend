import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where this backend's PAIRED frontend actually is.
 *
 * Three gates here each hardcoded a monorepo layout of `<root>/frontend`:
 * `check:file-sizes`, `check:permission-keys` and `check:navigation-permissions`.
 * The checkout is not laid out that way and never has been, so all three
 * resolved to paths that do not exist — the first exiting 1, the other two
 * exiting 2 — on every run. `check:permission-keys` is the gate that proves a
 * backend key is typeable in the frontend and that a frontend-only ghost key
 * cannot exist, and it has never once made that comparison in this worktree.
 *
 * ## Why this is not a copy of the backend's own repo-roots.mjs
 *
 * That one resolves `streamlineos-frontend/frontend` and is correct for the
 * repository it lives in. Copying it here would be WORSE THAN THE BUG: this is
 * `inv-wt-backend`, a worktree on `feat/inventory-world-class-implementation`,
 * and its frontend is the matching worktree `inv-wt-frontend`. Pointing it at
 * `streamlineos-frontend` would compare an inventory backend against a CRM
 * frontend on a different branch and report the difference as drift — a gate
 * that is confidently wrong, rather than one that admits it cannot run.
 *
 * So the pairing is derived from the directory name: a checkout ending
 * `-backend` pairs with the sibling of the same prefix ending `-frontend`.
 * `inv-wt-backend` → `inv-wt-frontend`, `ts-wt-backend` → `ts-wt-frontend`,
 * `streamlineos-backend` → `streamlineos-frontend`. The paired candidate is
 * probed FIRST and the generic layouts remain as fallbacks, so nothing is
 * guessed: an unresolvable root returns null and the caller still exits 2
 * naming every path it tried.
 *
 * Two different roots are needed and they are not the same directory:
 *   repo root — `<pair>/`          holds architecture-refactor/, docs, scripts
 *   app root  — `<pair>/frontend/` holds lib/, components/, app/
 * Asking for the wrong one is how a gate finds the checkout and still reports
 * the file it wants as missing.
 */

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));

/** `src/scripts/lib` → `src/scripts` → `src` → the backend repo root. */
export const BACKEND_ROOT = resolve(SCRIPT_DIR, "../../..");

/** The directory holding the backend and frontend checkouts side by side. */
export const WORKSPACE_ROOT = resolve(BACKEND_ROOT, "..");

function firstExisting(candidates) {
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return null;
}

/** `inv-wt-backend` → `inv-wt-frontend`; null when the name does not end in `-backend`. */
export function pairedFrontendName(backendDirName = basename(BACKEND_ROOT)) {
  return backendDirName.endsWith("-backend")
    ? `${backendDirName.slice(0, -"-backend".length)}-frontend`
    : null;
}

function frontendRepoCandidates() {
  const paired = pairedFrontendName();
  return [
    ...(paired ? [join(WORKSPACE_ROOT, paired)] : []),
    join(WORKSPACE_ROOT, "streamlineos-frontend"),
    WORKSPACE_ROOT,
  ];
}

/**
 * The frontend REPOSITORY root — the directory holding `architecture-refactor/`.
 * Probed by that marker rather than by mere existence, because
 * `WORKSPACE_ROOT` always exists and would otherwise match every time.
 */
export function resolveFrontendRepoRoot() {
  const candidates = frontendRepoCandidates();
  const root = firstExisting(candidates.map((c) => join(c, "architecture-refactor")));
  return { root: root ? resolve(root, "..") : null, candidates };
}

/**
 * The Next.js APPLICATION root — the directory holding `lib/`, `components/`
 * and `app/`. Usually `<repo>/frontend`, but a monorepo puts it at the top.
 */
export function resolveFrontendRoot() {
  const candidates = [
    ...frontendRepoCandidates().map((c) => join(c, "frontend")),
    join(WORKSPACE_ROOT, "frontend"),
  ];
  const root = firstExisting(candidates.map((c) => join(c, "components")));
  return { root: root ? resolve(root, "..") : null, candidates };
}

/** The backend's `src/modules`, wherever the backend repo is called. */
export function resolveBackendModulesDir() {
  const candidates = [
    join(BACKEND_ROOT, "src", "modules"),
    join(WORKSPACE_ROOT, "backend", "src", "modules"),
  ];
  return { root: firstExisting(candidates), candidates };
}

/** Whether a connection string wants TLS. */
export function sslForConnectionString(connectionString) {
  return /[?&]sslmode=disable\b/.test(connectionString ?? "") ? false : "require";
}
