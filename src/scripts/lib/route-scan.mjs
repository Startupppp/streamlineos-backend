import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

export const READ_DECORATOR = /^\s*@(Get|Head|Options)\s*\(/;
export const WRITE_DECORATOR = /^\s*@(Post|Put|Patch|Delete|All|Sse)\s*\(/;
export const ANY_ROUTE_DECORATOR = /^\s*@(Get|Head|Options|Post|Put|Patch|Delete|All|Sse)\s*\(/;
export const OPT_OUT = /^\s*@NoTenantTransaction\s*\(/;
export const PUBLIC_ROUTE = /^\s*@Public\s*\(/;

const HANDLER = /^\s*(?:public\s+|private\s+|protected\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/;
const CONSTRUCTOR_PARAM =
  /(?:private|public|protected|readonly)\s+(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)/;
const METHOD_CALL = /this\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g;

export function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    if (extname(full) === ".ts") out.push(full);
  }
  return out;
}

export function isSpec(file) {
  return /\.(spec|e2e-spec)\.ts$/.test(file);
}

export function makeStripEscapedRegions(escapeHatch) {
  return function stripEscapedRegions(body) {
    let out = "";
    let index = 0;
    while (index < body.length) {
      const at = body.indexOf(escapeHatch, index);
      if (at === -1) {
        out += body.slice(index);
        break;
      }
      out += body.slice(index, at);
      let cursor = body.indexOf("(", at);
      if (cursor === -1) break;
      let depth = 0;
      while (cursor < body.length) {
        if (body[cursor] === "(") depth++;
        else if (body[cursor] === ")") {
          depth--;
          if (depth === 0) break;
        }
        cursor++;
      }
      index = cursor + 1;
    }
    return out;
  };
}

export function blockAfter(lines, start) {
  const text = lines.slice(start).join("\n");
  let cursor = 0;
  let paren = 0;
  let opened = false;

  while (cursor < text.length) {
    const char = text[cursor];
    if (char === "(") {
      paren++;
      opened = true;
    } else if (char === ")") {
      paren--;
      if (opened && paren === 0) {
        cursor++;
        break;
      }
    }
    cursor++;
  }

  let angle = 0;
  let bodyStart = -1;
  for (; cursor < text.length; cursor++) {
    const char = text[cursor];
    if (char === "<") angle++;
    else if (char === ">") {
      if (angle > 0) angle--;
    } else if (char === ";" && angle === 0) return "";
    else if (char === "{" && angle === 0) {
      bodyStart = cursor;
      break;
    }
  }
  if (bodyStart === -1) return "";

  let depth = 0;
  let end = bodyStart;
  for (; end < text.length; end++) {
    if (text[end] === "{") depth++;
    else if (text[end] === "}") {
      depth--;
      if (depth === 0) {
        end++;
        break;
      }
    }
  }
  return text.slice(bodyStart, end);
}

export function findRoutes(source, options) {
  const { collect, ignoreOptOut = false } = options;
  const lines = source.split("\n");
  const classLine = lines.findIndex((line) => /^export (?:abstract )?class /.test(line));
  if (classLine !== -1) {
    const preamble = lines.slice(0, classLine);
    const classExempt = preamble.some(
      (line) => PUBLIC_ROUTE.test(line) || (!ignoreOptOut && OPT_OUT.test(line)),
    );
    if (classExempt) return [];
  }

  const routes = [];
  let pendingCollect = false;
  let pendingOther = false;
  let pendingOptOut = false;
  let pendingPublic = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (collect.test(line)) {
      pendingCollect = true;
      continue;
    }
    if (ANY_ROUTE_DECORATOR.test(line)) {
      pendingOther = true;
      continue;
    }
    if (OPT_OUT.test(line)) {
      pendingOptOut = true;
      continue;
    }
    if (PUBLIC_ROUTE.test(line)) {
      pendingPublic = true;
      continue;
    }
    if (/^\s*@/.test(line) || line.trim() === "") continue;

    if (pendingCollect || pendingOther) {
      const handler = HANDLER.exec(line);
      if (handler) {
        const exempt = pendingPublic || (!ignoreOptOut && pendingOptOut);
        if (pendingCollect && !pendingOther && !exempt)
          routes.push({ handler: handler[1], body: blockAfter(lines, i) });
        pendingCollect = false;
        pendingOther = false;
        pendingOptOut = false;
        pendingPublic = false;
      }
    }
  }

  return routes;
}

export function injectedTypes(source) {
  const map = new Map();
  const start = source.indexOf("constructor(");
  if (start === -1) return map;
  const lines = source.slice(start).split("\n");
  let depth = 0;
  let seen = false;
  for (const line of lines) {
    const found = CONSTRUCTOR_PARAM.exec(line);
    if (found) map.set(found[1], found[2]);
    for (const char of line) {
      if (char === "(") {
        depth++;
        seen = true;
      } else if (char === ")") depth--;
    }
    if (seen && depth <= 0) break;
  }
  return map;
}

export function buildClassIndex(files) {
  const index = new Map();
  for (const file of files) {
    if (isSpec(file)) continue;
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/^export (?:abstract )?class ([A-Za-z_$][\w$]*)/gm))
      if (!index.has(match[1])) index.set(match[1], file);
  }
  return index;
}

export function methodBody(source, name) {
  const lines = source.split("\n");
  const pattern = new RegExp(
    `^\\s*(?:public\\s+|private\\s+|protected\\s+)?(?:async\\s+)?${name}\\s*\\(`,
  );
  for (let i = 0; i < lines.length; i++)
    if (pattern.test(lines[i])) return blockAfter(lines, i);
  return null;
}

const SELF_CALL = /this\.([A-Za-z_$][\w$]*)\s*\(/g;

export function makeReaches({ directly, maxHops, strip, followSameClass = false }) {
  return function reaches(body, classIndex, sourceOf, hops, seen) {
    if (directly(body)) return true;
    if (hops >= maxHops) return false;

    const visible = strip(body);

    if (followSameClass && typeof sourceOf.source === "string") {
      for (const call of visible.matchAll(SELF_CALL)) {
        const method = call[1];
        const key = `${sourceOf.file ?? "?"}#self#${method}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const nested = methodBody(sourceOf.source, method);
        if (nested === null) continue;
        if (reaches(nested, classIndex, sourceOf, hops + 1, seen)) return true;
      }
    }

    for (const call of visible.matchAll(METHOD_CALL)) {
      const [, prop, method] = call;
      const owner = sourceOf.types.get(prop);
      if (!owner) continue;
      const file = classIndex.get(owner);
      if (!file) continue;
      const key = `${owner}#${method}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const source = readFileSync(file, "utf8");
      const nested = methodBody(source, method);
      if (nested === null) continue;
      if (
        reaches(
          nested,
          classIndex,
          { types: injectedTypes(source), source, file },
          hops + 1,
          seen,
        )
      )
        return true;
    }
    return false;
  };
}
