import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the backend and the frontend actually are.
 *
 * Two cross-repo gates — `check:permission-keys` and
 * `check:navigation-permissions` — each hardcoded a monorepo layout of
 * `<root>/backend` and `<root>/frontend`. The checkout is not laid out that
 * way: it is `<root>/streamlineos-backend` and
 * `<root>/streamlineos-frontend/frontend`. Both gates therefore resolved to
 * paths that do not exist and exited 2 for a missing prerequisite, every run,
 * for as long as the layout has been this one.
 *
 * That is the good failure mode — they refused rather than passing over
 * nothing — but the effect is the same: `check:permission-keys` is the gate
 * that proves a backend key is typeable in the frontend and that a
 * frontend-only ghost key cannot exist, and it has never once made that
 * comparison here. A gate that cannot find its inputs is not a gate.
 *
 * Resolution probes candidates in order and returns the first that exists, so
 * the monorepo layout keeps working if the repository is ever arranged that
 * way. Nothing is guessed: an unresolvable root returns null and the caller
 * still exits 2 with a message naming every path it tried.
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

/**
 * The directory that holds `lib/`, `components/` and `app/` — i.e. the Next.js
 * application root, not the repository that contains it.
 */
export function resolveFrontendRoot() {
  const candidates = [
    // The layout this checkout actually uses.
    join(WORKSPACE_ROOT, "streamlineos-frontend", "frontend"),
    // A monorepo, which is what the gates originally assumed.
    join(WORKSPACE_ROOT, "frontend"),
    join(BACKEND_ROOT, "..", "frontend"),
  ];
  return { root: firstExisting(candidates), candidates };
}

/** The backend's `src/modules`, wherever the backend repo is called. */
export function resolveBackendModulesDir() {
  const candidates = [
    join(BACKEND_ROOT, "src", "modules"),
    join(WORKSPACE_ROOT, "backend", "src", "modules"),
  ];
  return { root: firstExisting(candidates), candidates };
}
