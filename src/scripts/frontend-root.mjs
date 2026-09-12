/**
 * Where the frontend checkout is, and which one it is.
 *
 * Two gates — `check:permission-keys` and `check:navigation-permissions` —
 * resolved it as `<repo>/frontend`, a sibling of `<repo>/backend`. That layout
 * does not exist here: the repositories are `streamline/streamlineos-backend`
 * and `streamline/streamlineos-frontend/frontend`. Both gates therefore exited
 * 2 with "cannot read frontend union files" from every checkout including the
 * main one, and had never run. A gate that cannot find its input is not a
 * passing gate; it is an absent one.
 *
 * The second problem is subtler and cost a day on the inventory pack. Picking
 * *a* frontend is not enough — picking the wrong branch's frontend produces
 * confident, wrong answers. `catalog-sync` once read a backend ~200 migrations
 * behind and reported 22 live permission keys as phantoms; acting on it would
 * have deleted them. So this resolver prefers the paired worktree, and when it
 * cannot find one it says out loud which checkout it fell back to, so a
 * cross-branch comparison is visible in the output rather than assumed away.
 */

import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** A file that only a real frontend checkout has. */
const MARKER = join("lib", "rbac", "permissions", "permission-key-foundation.ts");

function isFrontend(dir) {
  return existsSync(join(dir, MARKER));
}

/**
 * `…/inv-wt-backend` → `…/inv-wt-frontend`, the worktree pair convention used
 * here. Tried first so a gate run from a feature worktree compares against that
 * feature's frontend rather than whatever the default checkout happens to be on.
 */
function pairedWorktree(backendRoot) {
  const name = basename(backendRoot);
  if (!name.endsWith("-backend")) return null;
  return join(dirname(backendRoot), `${name.slice(0, -"-backend".length)}-frontend`);
}

/**
 * Resolves the frontend root from a backend checkout.
 *
 * Returns `{ root, paired, candidatesTried }`. `paired: false` means the answer
 * came from a different checkout than the backend being scanned, which callers
 * should print.
 */
export function resolveFrontendRoot(backendRoot) {
  const tried = [];
  const paired = pairedWorktree(backendRoot);

  /** Each repository nests the Next app one level down; older layouts do not. */
  const shapes = (base) => [join(base, "frontend"), base];

  if (paired) {
    for (const candidate of shapes(paired)) {
      tried.push(candidate);
      if (isFrontend(candidate)) return { root: candidate, paired: true, candidatesTried: tried };
    }
  }

  const parent = dirname(backendRoot);
  const fallbacks = [
    ...shapes(join(parent, "streamlineos-frontend")),
    ...shapes(join(parent, "frontend")),
    ...shapes(resolve(backendRoot, "..", "..", "frontend")),
  ];
  for (const candidate of fallbacks) {
    tried.push(candidate);
    if (isFrontend(candidate)) return { root: candidate, paired: false, candidatesTried: tried };
  }

  return { root: null, paired: false, candidatesTried: tried };
}

/** One line for a gate to print, so the comparison's basis is never implicit. */
export function describeFrontendRoot(resolved) {
  if (!resolved.root) {
    return (
      `Cannot find a frontend checkout. Tried:\n  ${resolved.candidatesTried.join("\n  ")}\n` +
      `A checkout is recognised by ${MARKER}.`
    );
  }
  if (resolved.paired) return `Frontend: ${resolved.root} (paired worktree)`;
  return (
    `Frontend: ${resolved.root} (NOT a paired worktree — this compares against ` +
    `whatever branch that checkout is on, which may not be this one)`
  );
}
