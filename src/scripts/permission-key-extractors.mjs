/**
 * permission-key-extractors.mjs
 *
 * The single implementation of "where do permission keys appear, and what do
 * they resolve to". Two CI checks ask the same question of the same files —
 * check-permission-keys (does every route key exist in both catalogs?) and
 * check-navigation-permissions (does every navigation gate name a key some route
 * enforces?) — and two copies of a security predicate is the defect c15-06 exists
 * to prevent.
 *
 * Every parse function here is pure: source text in, keys out. Both callers'
 * --self-test modes drive them with fixture strings, so a bug in an extractor
 * fails a self-test rather than silently reporting zero findings.
 *
 * TWO WAYS A TEXT SCAN OF THIS CODEBASE LIES, both fixed here:
 *
 *   1. The catalog is not all string literals. `<module>:access:view` and
 *      `:manage` are generated from `delegableModuleIds()` as template literals
 *      (permissions/module-access.ts:14), so `name: "..."` finds none of them and
 *      a check built on it reports twelve real keys as ghosts. loadBackendCatalog
 *      runs the real module through ts-node instead of guessing.
 *
 *   2. @RequirePermission is not always a string literal either. 21 route usages
 *      pass a module-level constant (`@RequirePermission(REVIEW_PERMISSION)`), so
 *      a literal-only regex silently skips those routes — a permission check that
 *      quietly declines to check. parseRouteRefs resolves constants and reports
 *      any argument it could not resolve, because unverifiable must not read as
 *      verified.
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(SCRIPT_DIR, "../..");

/**
 * The real backend catalog, loaded rather than parsed.
 * Returns { names, scopable, accessManaged } — the first two as Sets, the third
 * as the module-id array the `<module>:access:*` keys are generated from.
 * Throws if the dump fails — a check that cannot read the catalog must fail
 * loudly, never report zero findings.
 */
export function loadBackendCatalog() {
  const raw = execFileSync(
    process.execPath,
    ["-r", "ts-node/register/transpile-only", resolve(SCRIPT_DIR, "dump-permission-catalog.ts")],
    { cwd: BACKEND_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.names) || parsed.names.length === 0)
    throw new Error("permission catalog dump returned no keys");
  if (!Array.isArray(parsed.accessManaged) || parsed.accessManaged.length === 0)
    throw new Error("permission catalog dump returned no access-managed modules");
  return {
    names: new Set(parsed.names),
    scopable: new Set(parsed.scopable),
    accessManaged: parsed.accessManaged,
  };
}

/**
 * Extract PermissionKey union literal values from the frontend type files.
 * sources: iterable of source strings (one per file).
 */
export function parseUnionKeys(sources) {
  const keys = new Set();
  for (const src of sources) {
    for (const m of src.matchAll(/\|\s*["']([^"']+)["']/g)) {
      if (m[1].includes(":")) keys.add(m[1]);
    }
  }
  return keys;
}

/**
 * Module-level `const NAME = "module:resource:action"` declarations, which is
 * how the five constant-argument decorators in this repo are written.
 * Returns Map<identifier, key>.
 */
export function parsePermissionConstants(src) {
  const constants = new Map();
  for (const m of src.matchAll(/\bconst\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*["']([^"']*:[^"']*)["']/g))
    constants.set(m[1], m[2]);
  return constants;
}

/**
 * Extract @RequirePermission(...) usages from a single source file.
 *
 * `constants` is a Map<identifier, key> built from parsePermissionConstants over
 * every scanned file; an identifier argument resolves through it.
 *
 * Returns { key, identifier, file, line, resolved }[] — 1-based lines.
 * `resolved` is false when the argument was an identifier no constant explains;
 * callers must treat that as a failure, not as an absence.
 */
export function parseRouteRefs(src, filePath, constants = new Map()) {
  const refs = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const literal = lines[i].match(/@RequirePermission\(\s*["']([^"']+)["']\s*\)/);
    if (literal) {
      refs.push({ key: literal[1], identifier: null, file: filePath, line: i + 1, resolved: true });
      continue;
    }
    const ident = lines[i].match(/@RequirePermission\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)/);
    if (!ident) continue;
    const key = constants.get(ident[1]) ?? null;
    refs.push({
      key,
      identifier: ident[1],
      file: filePath,
      line: i + 1,
      resolved: key !== null,
    });
  }
  return refs;
}

/**
 * Extract navigation gates from a frontend sidebar manifest.
 *
 * The manifest is a plain array of object literals, so this reads it as text
 * rather than importing it — the backend has no JSX loader and importing the real
 * module would drag in `lucide-react` and `@/lib/rbac/permissions`.
 *
 * A route literal is written `label` -> `icon` -> `href` -> `requiredPermission`,
 * and a group literal is `label` -> `product` -> `module` -> `requiredPermission`,
 * so the nearest preceding `href` identifies a destination and the nearest
 * preceding `label` identifies a group. `href` resets on every `label` so a group
 * gate is never mis-attributed to the previous group's last route.
 *
 * Returns { key, file, line, href, label }[] — one entry per key, so a
 * `requiredPermission: [a, b]` array yields two.
 */
export function parseNavGates(src, filePath) {
  const gates = [];
  const lines = src.split("\n");
  let label = null;
  let href = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const labelMatch = line.match(/\blabel:\s*["']([^"']*)["']/);
    if (labelMatch) {
      label = labelMatch[1];
      href = null;
    }

    const hrefMatch = line.match(/\bhref:\s*["']([^"']*)["']/);
    if (hrefMatch) href = hrefMatch[1];

    if (!/\brequiredPermission:/.test(line)) continue;

    const inline = [...line.matchAll(/["']([^"']*:[^"']*)["']/g)].map((m) => m[1]);
    if (inline.length > 0) {
      for (const key of inline) gates.push({ key, file: filePath, line: i + 1, href, label });
      continue;
    }

    // Multi-line array form: consume until the closing bracket.
    if (!/\[\s*$/.test(line)) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const body = lines[j];
      for (const m of body.matchAll(/["']([^"']*:[^"']*)["']/g))
        gates.push({ key: m[1], file: filePath, line: j + 1, href, label });
      if (/\]/.test(body)) break;
    }
  }

  return gates;
}
