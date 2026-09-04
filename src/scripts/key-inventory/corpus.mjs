/**
 * The reachability corpus behind the PRD-C057 inventory.
 *
 * Two traps the prior wave documented and both fired again here, so both are
 * handled: a scan that matches only `pgTable(` maps nothing when a table is
 * declared through `pgSchema().table()` (83 Build tables), and a scan that does
 * not strip `//` comment lines silently counts commented-out code as a live
 * reference. A token census that lies in either direction turns "unused" into a
 * deletion instruction, so the census records WHERE each token was seen and the
 * inventory carries that file:line as the entry's evidence.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "dist",
  "coverage",
  ".turbo",
  "build",
  ".scratch",
]);

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".js", ".json", ".sql"]);

export function walk(root, { skipPaths = [], extensions = CODE_EXTENSIONS } = {}) {
  const out = [];
  const skip = skipPaths.map((path) => path.replace(/\/$/, ""));
  const visit = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      const rel = relative(root, full);
      if (skip.some((path) => rel === path || rel.startsWith(`${path}/`))) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        visit(full);
        continue;
      }
      const dot = entry.name.lastIndexOf(".");
      if (dot < 0) continue;
      if (!extensions.has(entry.name.slice(dot))) continue;
      out.push(full);
    }
  };
  visit(root);
  return out;
}

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;

/**
 * token -> "path:line" of the FIRST sighting. Comment-only lines are stripped so
 * commented-out code never counts as a reference; a `//` inside a string literal
 * is rare enough in this corpus that the conservative cut is the right trade.
 */
export function tokenIndex(files, { root, label }) {
  const index = new Map();
  let lines = 0;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const rel = relative(root, file);
    const split = text.split("\n");
    for (let i = 0; i < split.length; i += 1) {
      const raw = split[i] ?? "";
      const line = raw.replace(/^\s*(\/\/|\*|\/\*).*$/, "");
      if (line.trim() === "") continue;
      lines += 1;
      const matches = line.match(IDENTIFIER);
      if (matches === null) continue;
      for (const token of matches) {
        if (!index.has(token)) index.set(token, `${label}:${rel}:${String(i + 1)}`);
      }
    }
  }
  return { index, files: files.length, lines };
}

const QUOTED = /["'`]([^"'`\n]{2,120})["'`]/g;

/**
 * Quoted string literals, indexed by their exact text. A permission key, an event
 * name and a cache namespace all contain a colon, so the identifier census cannot
 * see them: it splits `"hr:bank-details:view"` into four unrelated tokens and
 * reports the key as reached because the word `view` appears somewhere. Reaching a
 * colon-joined key is a LITERAL question, not a token question.
 */
export function literalIndex(files, { root, label }) {
  const index = new Map();
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const rel = relative(root, file);
    const split = text.split("\n");
    for (let i = 0; i < split.length; i += 1) {
      const raw = split[i] ?? "";
      if (/^\s*(\/\/|\*|\/\*)/.test(raw)) continue;
      for (const match of raw.matchAll(QUOTED)) {
        const literal = match[1];
        if (literal === undefined) continue;
        if (!index.has(literal)) index.set(literal, `${label}:${rel}:${String(i + 1)}`);
      }
    }
  }
  return index;
}

export function snakeToCamel(name) {
  return name.replace(/_([a-z0-9])/g, (_match, character) => String(character).toUpperCase());
}

/** A token is reached when either naming convention is sighted anywhere. */
export function reach(indexes, name) {
  const camel = snakeToCamel(name);
  for (const index of indexes) {
    const direct = index.get(name);
    if (direct !== undefined) return direct;
    const asCamel = index.get(camel);
    if (asCamel !== undefined) return asCamel;
  }
  return null;
}
