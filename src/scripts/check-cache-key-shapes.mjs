/**
 * Cache key SHAPE resolution for check-cache-invalidation.mjs.
 *
 * The gate this serves used to compare keyword PRESENCE: "does the string
 * `hr:headcount` appear anywhere in this file". A substring test can never
 * detect that the read key and the delete key are two different strings, which
 * is the entire defect class — `hrHeadcountNamespace` was read as
 * `hr:headcount:<org>` and bumped as `<org>:hr:headcount`, two counters on two
 * Redis instances, and every gate in the repository stayed green.
 *
 * So this resolves both sides to a key SHAPE (every `${…}` becomes `*`) and
 * compares shapes:
 *
 *   falsePrefix        an exact-key invalidate shape is a wildcard-aware segment
 *                      prefix of some write shape — a `redis.del` that cannot
 *                      reach what was written. There is no prefix delete in this
 *                      codebase (`invalidate` is `redis.del(exactKey)`).
 *   namespaceMismatch  a namespace bump whose shape matches no `cachedVersioned*`
 *                      read shape — a generation counter nobody reads.
 *
 * `<ORG>:` is deliberately NOT normalised away. The `*ForOrg` family prefixes the
 * org and resolves the org's Redis cell; the global family does neither. Treating
 * them as equal erases exactly the asymmetry that was the bug.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ORG = "<ORG>";

const CACHE_METHOD_NAMES = [
  "cachedVersionedForOrg",
  "cachedVersioned",
  "cachedForOrgWith",
  "cachedForOrg",
  "cached",
  "set",
  "invalidateNamespaceForOrg",
  "invalidateNamespace",
  "invalidateForOrg",
  "invalidate",
  "del",
];

const PREFILTER_RE = new RegExp(`\\.\\s*(?:${CACHE_METHOD_NAMES.join("|")})\\s*\\(`);

/** Replace every `${…}` interpolation with `*`. */
export function templateToShape(template) {
  return template.replace(/\$\{[^}]*\}/g, "*").trim();
}

/**
 * Parse `cache-keys.ts` into name → shape. A factory wrapped in `namespace(...)`
 * is recorded as a namespace so a bump can be told from an exact-key delete.
 */
export function parseCacheKeyFactories(source) {
  const factories = new Map();
  const re = /^\s{2}([A-Za-z0-9_]+):\s*\([^)]*\)\s*=>\s*(namespace\()?\s*`([^`]*)`/gm;
  let m;
  while ((m = re.exec(source)) !== null) {
    factories.set(m[1], { shape: templateToShape(m[3]), isNamespace: m[2] !== undefined });
  }
  return factories;
}

/** Module-local `const X = (a, b) => \`…\`` key factories declared in the same file. */
export function parseLocalFactories(source) {
  const factories = new Map();
  const re = /\bconst\s+([A-Za-z0-9_]+)\s*=\s*\([^)]*\)\s*(?::\s*[^=]+)?=>\s*`([^`]*)`/g;
  let m;
  while ((m = re.exec(source)) !== null) factories.set(m[1], templateToShape(m[2]));
  return factories;
}

/** Split a call's argument list at top level, respecting (), {}, [], `` and quotes. */
export function splitArgs(text, openParenIndex) {
  const args = [];
  let depth = 0;
  let current = "";
  let quote = null;
  for (let i = openParenIndex; i < text.length; i++) {
    const ch = text[i];
    if (quote !== null) {
      current += ch;
      if (ch === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      if (depth === 1 && ch === "(") continue;
      current += ch;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        if (current.trim() !== "") args.push(current.trim());
        return args;
      }
      current += ch;
      continue;
    }
    if (ch === "," && depth === 1) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") args.push(current.trim());
  return args;
}

/**
 * Resolve one argument expression to a key shape, or null when it cannot be
 * resolved. An unresolvable argument is dropped rather than guessed: a wrong
 * shape is worse than a missing one, because it produces a false finding that
 * gets the whole gate switched off.
 */
export function resolveArgShape(arg, cacheKeyFactories, localFactories) {
  const trimmed = arg.trim();

  const template = /^`([^`]*)`$/.exec(trimmed);
  if (template) return templateToShape(template[1]);

  const literal = /^["']([^"']*)["']$/.exec(trimmed);
  if (literal) return literal[1];

  const cacheKey = /^CACHE_KEYS\.([A-Za-z0-9_]+)\s*\(/.exec(trimmed);
  if (cacheKey) {
    const entry = cacheKeyFactories.get(cacheKey[1]);
    return entry === undefined ? null : entry.shape;
  }

  const local = /^([A-Za-z0-9_]+)\s*\(/.exec(trimmed);
  if (local) {
    const shape = localFactories.get(local[1]);
    return shape === undefined ? null : shape;
  }

  return null;
}

const WRITE_METHODS = new Set(["cached", "set", "cachedForOrg", "cachedForOrgWith", "cachedVersioned", "cachedVersionedForOrg"]);
const INVALIDATE_METHODS = new Set(["invalidate", "del", "invalidateForOrg", "invalidateNamespace", "invalidateNamespaceForOrg"]);

/**
 * All cache write and invalidate sites in one file, resolved to shapes.
 * Returns { writes, invalidates } of { method, shape, kind, line }.
 *   kind: "exact" | "namespace"
 */
export function resolveFileSites(source, relPath, cacheKeyFactories) {
  const localFactories = parseLocalFactories(source);
  const writes = [];
  const invalidates = [];

  const callRe = new RegExp(`\\.\\s*(${CACHE_METHOD_NAMES.join("|")})\\s*\\(`, "g");
  let m;
  while ((m = callRe.exec(source)) !== null) {
    const method = m[1];
    if (!WRITE_METHODS.has(method) && !INVALIDATE_METHODS.has(method)) continue;
    const args = splitArgs(source, m.index + m[0].length - 1);
    const line = source.slice(0, m.index).split("\n").length;
    const arg = (i) => (args[i] === undefined ? null : resolveArgShape(args[i], cacheKeyFactories, localFactories));

    let shape = null;
    let kind = "exact";

    switch (method) {
      case "cached":
      case "set":
      case "invalidate":
      case "del":
        shape = arg(0);
        break;
      case "cachedForOrg":
      case "cachedForOrgWith":
      case "invalidateForOrg": {
        const k = arg(1);
        shape = k === null ? null : `${ORG}:${k}`;
        break;
      }
      case "cachedVersioned": {
        const ns = arg(0);
        const sub = arg(1);
        shape = ns === null ? null : `${ns}:v*:${sub ?? "*"}`;
        kind = "namespace-read";
        break;
      }
      case "cachedVersionedForOrg": {
        const ns = arg(1);
        const sub = arg(2);
        shape = ns === null ? null : `${ORG}:${ns}:v*:${sub ?? "*"}`;
        kind = "namespace-read";
        break;
      }
      case "invalidateNamespace":
        shape = arg(0);
        kind = "namespace";
        break;
      case "invalidateNamespaceForOrg": {
        const ns = arg(1);
        shape = ns === null ? null : `${ORG}:${ns}`;
        kind = "namespace";
        break;
      }
      default:
        break;
    }

    if (shape === null || shape === "") continue;
    const site = { method, shape, kind, file: relPath, line };
    if (WRITE_METHODS.has(method)) writes.push(site);
    else invalidates.push(site);
  }

  return { writes, invalidates };
}

/**
 * Wildcard-aware segment prefix: `child` is strictly longer than `parent` and
 * every shared position is equal unless either side is `*`.
 */
export function segmentPrefix(parent, child) {
  const p = parent.split(":");
  const c = child.split(":");
  if (c.length <= p.length) return false;
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "*" || c[i] === "*") continue;
    if (p[i] !== c[i]) return false;
  }
  return true;
}

/** Noise filter: a shape must carry at least two literal segments to be compared. */
export function hasEnoughLiteralSegments(shape, min = 2) {
  return shape.split(":").filter((s) => s !== "*" && s !== ORG && s !== "").length >= min;
}

/**
 * A `redis.del` of an exact key that is a strict segment prefix of something the
 * codebase actually writes. There is no prefix delete: this cannot reach it.
 */
export function findFalsePrefixDeletes(writes, invalidates) {
  const writeShapes = new Set(writes.filter((w) => w.kind === "exact").map((w) => w.shape));
  const findings = [];
  for (const inv of invalidates) {
    if (inv.kind !== "exact") continue;
    if (inv.shape.startsWith("*")) continue;
    if (!hasEnoughLiteralSegments(inv.shape)) continue;
    const unreachable = [...writeShapes].filter((w) => segmentPrefix(inv.shape, w));
    if (unreachable.length === 0) continue;
    // A delete that also matches one write exactly is still a defect when other
    // keys sit under the same stem: `hr:analytics:<org>` cleared the overview and
    // silently missed `hr:analytics:attendance:…` and `…:attrition:…`.
    const exactMatch = writeShapes.has(inv.shape);
    findings.push({ ...inv, written: unreachable.sort(), exactMatch });
  }
  return findings;
}

/**
 * A generation-counter bump whose shape no `cachedVersioned*` read uses. The
 * `<ORG>:` prefix is significant and is not normalised away.
 */
export function findNamespaceCounterMismatches(writes, invalidates) {
  const readNamespaces = new Set(
    writes.filter((w) => w.kind === "namespace-read").map((w) => w.shape.replace(/:v\*:.*$/, "")),
  );
  const findings = [];
  for (const inv of invalidates) {
    if (inv.kind !== "namespace") continue;
    if (inv.shape.startsWith("*")) continue;
    if (!hasEnoughLiteralSegments(inv.shape, 1)) continue;
    if (readNamespaces.has(inv.shape)) continue;
    findings.push({ ...inv, knownReadNamespaces: [...readNamespaces].sort() });
  }
  return findings;
}

export function walkTsFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
      walkTsFiles(full, out);
    } else if (
      entry.endsWith(".ts") &&
      !entry.endsWith(".spec.ts") &&
      !entry.endsWith(".e2e-spec.ts") &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

export function resolveAllSites(srcDir, cacheKeysPath) {
  const cacheKeyFactories = parseCacheKeyFactories(readFileSync(cacheKeysPath, "utf8"));
  const writes = [];
  const invalidates = [];
  const files = walkTsFiles(srcDir);
  for (const file of files) {
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // The cheap pre-filter must not be narrower than the real matcher. An
    // earlier form required `cachedVersioned(` and so skipped every file that
    // only uses `cachedVersionedForOrg(` — three whole HR read families.
    if (!PREFILTER_RE.test(source)) continue;
    const rel = file.slice(file.indexOf("/src/") + 1);
    const sites = resolveFileSites(source, rel, cacheKeyFactories);
    writes.push(...sites.writes);
    invalidates.push(...sites.invalidates);
  }
  return { writes, invalidates, cacheKeyFactories, fileCount: files.length };
}
