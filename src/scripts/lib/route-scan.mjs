import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

export const READ_DECORATOR = /^\s*@(Get|Head|Options)\s*\(/;
export const WRITE_DECORATOR = /^\s*@(Post|Put|Patch|Delete|All|Sse)\s*\(/;
export const ANY_ROUTE_DECORATOR = /^\s*@(Get|Head|Options|Post|Put|Patch|Delete|All|Sse)\s*\(/;
export const OPT_OUT = /^\s*@NoTenantTransaction\s*\(/;
export const PUBLIC_ROUTE = /^\s*@Public\s*\(/;

const HANDLER = /^\s*(?:public\s+|private\s+|protected\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/;
const TYPE_WRAPPERS = new Set(["Pick", "Omit", "Partial", "Readonly", "Required", "Promise"]);
const CONSTRUCTOR_PARAM =
  /(?:private|public|protected|readonly)\s+(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)(?:\s*<\s*([A-Za-z_$][\w$]*))?/;

function unwrapType(outer, inner) {
  return inner && TYPE_WRAPPERS.has(outer) ? inner : outer;
}
const METHOD_CALL = /this\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g;

function readSource(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

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
  let decoratorDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (decoratorDepth > 0) {
      for (const char of line) {
        if (char === "(") decoratorDepth++;
        else if (char === ")") decoratorDepth--;
      }
      continue;
    }
    if (/^\s*@/.test(line)) {
      let depth = 0;
      for (const char of line) {
        if (char === "(") depth++;
        else if (char === ")") depth--;
      }
      if (depth > 0) {
        if (collect.test(line)) pendingCollect = true;
        else if (ANY_ROUTE_DECORATOR.test(line)) pendingOther = true;
        else if (OPT_OUT.test(line)) pendingOptOut = true;
        else if (PUBLIC_ROUTE.test(line)) pendingPublic = true;
        decoratorDepth = depth;
        continue;
      }
    }
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

export function parameterTypes(signature) {
  const map = new Map();
  for (const match of signature.matchAll(
    /(?:^|[(,])\s*([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)(?:\s*<\s*([A-Za-z_$][\w$]*))?/g,
  ))
    map.set(match[1], unwrapType(match[2], match[3]));
  return map;
}

export function signatureOf(source, name) {
  const lines = source.split("\n");
  const pattern = new RegExp(
    `^\\s*(?:export\\s+)?(?:public\\s+|private\\s+|protected\\s+)?(?:async\\s+)?(?:function\\s+)?${name}\\s*\\(`,
  );
  for (let i = 0; i < lines.length; i++) {
    if (!pattern.test(lines[i])) continue;
    const text = lines.slice(i).join("\n");
    let depth = 0;
    for (let cursor = 0; cursor < text.length; cursor++) {
      if (text[cursor] === "(") depth++;
      else if (text[cursor] === ")") {
        depth--;
        if (depth === 0) return text.slice(0, cursor + 1);
      }
    }
    return "";
  }
  return "";
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
    if (found) map.set(found[1], unwrapType(found[2], found[3]));
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

export function buildFunctionIndex(files) {
  const index = new Map();
  for (const file of files) {
    if (isSpec(file)) continue;
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(
      /^export (?:async )?function ([A-Za-z_$][\w$]*)/gm,
    ))
      if (!index.has(match[1])) index.set(match[1], file);
  }
  return index;
}

export function methodBody(source, name) {
  const lines = source.split("\n");
  const pattern = new RegExp(
    `^\\s*(?:export\\s+)?(?:public\\s+|private\\s+|protected\\s+)?(?:async\\s+)?(?:function\\s+)?${name}\\s*\\(`,
  );
  for (let i = 0; i < lines.length; i++)
    if (pattern.test(lines[i])) return blockAfter(lines, i);
  return null;
}

const SELF_CALL = /this\.([A-Za-z_$][\w$]*)\s*\(/g;
const FREE_CALL = /(?<![.\w])([a-z][\w$]*)\s*\(/g;
const LOCAL_CALL = /(?<![.\w])([a-z][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;

export function makeReaches({
  directly,
  maxHops,
  strip,
  followSameClass = false,
  functionIndex = null,
}) {
  return function reaches(body, classIndex, sourceOf, hops, seen) {
    if (directly(body)) return true;
    if (hops >= maxHops) return false;

    const visible = strip(body);

    if (functionIndex) {
      for (const call of visible.matchAll(FREE_CALL)) {
        const name = call[1];
        const file = functionIndex.get(name);
        if (!file) continue;
        const key = `fn#${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const source = readSource(file);
        if (source === null) continue;
        const nested = methodBody(source, name);
        if (nested === null) continue;
        const types = new Map([
          ...injectedTypes(source),
          ...parameterTypes(signatureOf(source, name)),
        ]);
        if (reaches(nested, classIndex, { types, source, file }, hops + 1, seen)) return true;
        seen.delete(key);
      }
    }

    if (sourceOf.types.size > 0) {
      for (const call of visible.matchAll(LOCAL_CALL)) {
        const [, receiver, method] = call;
        const owner = sourceOf.types.get(receiver);
        if (!owner) continue;
        const file = classIndex.get(owner);
        if (!file) continue;
        const key = `${owner}#${method}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const source = readSource(file);
        if (source === null) continue;
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
        seen.delete(key);
      }
    }

    if (followSameClass && typeof sourceOf.source === "string") {
      for (const call of visible.matchAll(SELF_CALL)) {
        const method = call[1];
        const key = `${sourceOf.file ?? "?"}#self#${method}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const nested = methodBody(sourceOf.source, method);
        if (nested === null) continue;
        if (reaches(nested, classIndex, sourceOf, hops + 1, seen)) return true;
        seen.delete(key);
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
      const source = readSource(file);
      if (source === null) continue;
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
      seen.delete(key);
    }
    return false;
  };
}
