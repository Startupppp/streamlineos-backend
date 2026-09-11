/**
 * One implementation of "where do permission keys appear, and what do they
 * resolve to", shared by check-permission-keys and check-navigation-permissions.
 *
 * Two ways a text scan of this codebase lies, both handled here: the catalog's
 * `<module>:access:*` keys are generated template literals, and 21 routes pass
 * @RequirePermission a constant rather than a literal.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(SCRIPT_DIR, "../..");
export const COMMITTED_MODULE_MANIFEST = resolve(BACKEND_ROOT, "module-manifest.json");

// The module manifest, loaded rather than parsed — every manifest check uses this
export function loadModuleManifest() {
  const raw = execFileSync(
    process.execPath,
    ["-r", "ts-node/register/transpile-only", resolve(SCRIPT_DIR, "dump-module-manifest.ts")],
    { cwd: BACKEND_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const parsed = JSON.parse(raw);
  if (typeof parsed.version !== "number" || !Array.isArray(parsed.modules) || parsed.modules.length === 0)
    throw new Error("module manifest dump returned invalid data");
  return parsed;
}

// Read from the COMMITTED manifest, never a ts-node spawn: the alerting scripts import this. `module-manifest-sync.spec.ts` fails if that file drifts from MODULE_REGISTRY.
export function committedModuleManifest() {
  const parsed = JSON.parse(readFileSync(COMMITTED_MODULE_MANIFEST, "utf8"));
  if (typeof parsed.version !== "number" || !Array.isArray(parsed.modules) || parsed.modules.length === 0)
    throw new Error(`${COMMITTED_MODULE_MANIFEST} is not a valid module manifest`);
  return parsed;
}

let namespaceAdministrationMap = null;

function namespaceToAdministeringModule() {
  if (namespaceAdministrationMap === null) {
    namespaceAdministrationMap = new Map();
    for (const entry of committedModuleManifest().modules)
      for (const namespace of entry.administersNamespaces ?? [])
        namespaceAdministrationMap.set(namespace, entry.id);
    if (namespaceAdministrationMap.size === 0)
      throw new Error("module manifest declares no administered namespaces; the scan would report every key unadministered");
  }
  return namespaceAdministrationMap;
}

// RUNTIME ENTITLEMENT: the key's own namespace. Mirrors namespaceOf() in common/rbac/module-vocabulary.ts.
export function namespaceOf(permissionKey) {
  const separatorIndex = permissionKey.indexOf(":");
  return separatorIndex === -1 ? permissionKey : permissionKey.slice(0, separatorIndex);
}

// ADMINISTRATION: derived from MODULE_REGISTRY.administersNamespaces via the manifest, never a second hand-copied table.
export function moduleOwningNamespace(namespace) {
  return namespaceToAdministeringModule().get(namespace) ?? namespace;
}

// ADMINISTRATION for a key. Never the runtime-entitlement question namespaceOf answers.
export function administeringModuleOf(permissionKey) {
  return moduleOwningNamespace(namespaceOf(permissionKey));
}

// The real backend catalog, loaded rather than parsed
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

// Extract PermissionKey union literal values from the frontend type files
export function parseUnionKeys(sources) {
  const keys = new Set();
  for (const src of sources) {
    for (const m of src.matchAll(/\|\s*["']([^"']+)["']/g)) {
      if (m[1].includes(":")) keys.add(m[1]);
    }
  }
  return keys;
}

// Module-level `const NAME = "module:resource:action"` declarations, which is how the five constant-argument decorators in this repo are written
export function parsePermissionConstants(src) {
  const constants = new Map();
  for (const m of src.matchAll(/\bconst\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*["']([^"']*:[^"']*)["']/g))
    constants.set(m[1], m[2]);
  return constants;
}

// Extract @RequirePermission(...) usages from a single source file
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

// Extract navigation gates from a frontend sidebar manifest
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

    // Multi-line array form
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
