#!/usr/bin/env node
/**
 * check-envelope-consistency.mjs  (section 7.1 — response/error envelope gate)
 *
 * WHAT IT CHECKS (OpenAPI document static analysis)
 *
 * 1. ERROR ENVELOPE — every 4xx and 5xx response on every operation should
 *    reference a shared error component (via $ref to #/components/responses/).
 *    Inline error schemas that differ per operation create frontend contract drift
 *    and make centralized error handling impossible.
 *
 * 2. PAGINATION ENVELOPE — every paginated collection endpoint (detected by
 *    the presence of a "cursor" or "page" query param AND a 200 response) should
 *    have a 200 response schema that references a component schema whose name
 *    contains "Paginated", "Page", or "Cursor", OR whose properties include
 *    "data" and at least one of "nextCursor", "cursor", "total", "page",
 *    "hasMore", "meta". A bare array response on a paginated endpoint is a
 *    contract mismatch with the frontend's envelope expectation.
 *
 * 3. SHARED COMPONENTS — the document must declare at least the four standard
 *    error components (BadRequest, Unauthorized, Forbidden, NotFound) under
 *    components.responses. If these are absent the error-ref checks above
 *    cannot pass.
 *
 * 4. SUCCESS ENVELOPE CONSISTENCY — collection responses that declare 200
 *    content should not mix raw-array schemas alongside paginated envelopes.
 *    Both patterns may be intentional for streaming/legacy routes, so this is
 *    reported, not failed on.
 *
 * WHY THIS GATE ALSO READS TYPESCRIPT (added 2026-09-03, v2 ticket 30)
 *
 * The four checks above read openapi.json and nothing else, and for check 2 that was very
 * nearly the same as reading nothing: of 336 paginated GETs, **2** carried a 2xx content
 * schema. The other 334 emit `"200": { "description": "" }`, because a response schema
 * appears in the document only where a handler carries `@ResponseSchema(...)` — and there are
 * 30 of those in a repository of 3,642 operations (see check:openapi-coverage, whose
 * RESPONSE_SCHEMA_UNCOVERED_CEILING records the same fact from the other side). So the rule
 * "a paginated endpoint must not answer with a bare array" was being evaluated against 0.60%
 * of the endpoints it is about, and printing a clean result.
 *
 * The document is therefore not the only evidence available, and it is not even the best:
 * the handler is. This gate now resolves each paginated GET's `operationId`
 * (`ControllerClass_methodName`) to its TypeScript source, follows the delegation chain into
 * the service that actually produces the value, and classifies the payload it returns. The
 * declared contract still wins where one exists — it is what the frontend compiles against —
 * and the source is read only where the document is silent.
 *
 * Resolution follows IMPORTS, never a global class-name index. Two different files here both
 * export `WebhooksService` (`modules/webhooks/` and `modules/inventory/webhooks/`), and a
 * name-keyed index reports the inventory one's bare array as the platform one's defect. The
 * platform one returns a perfectly good `{ data, pagination }`.
 *
 * WHAT THE SOURCE READER CAN AND CANNOT SEE
 * It reads return statements, one-hop-at-a-time delegation through constructor-injected
 * collaborators, `cachedVersioned`/`runInTenantTransaction`-style callback wrappers, local
 * `const` bindings, exported free functions, declared return types, and one property of a
 * local binding (`return file.body`, read from the type that names `body`). It gives up — and
 * says so, in the corpus line — on dynamic dispatch, re-export barrels and returns it cannot
 * trace to a shape. Anything it cannot classify is NOT counted as scanned: an unreadable
 * endpoint must never be indistinguishable from a clean one, which is the whole point of
 * gate-corpus.mjs.
 *
 * SELF-TEST (--self-test)
 * Proves each check category bites on a known-bad fixture, including the source reader's
 * classifier and the nested-callback rule that keeps `rows.map((r) => ({ ... }))` from being
 * read as the method's own return value.
 *
 * Usage:
 *   node src/scripts/check-envelope-consistency.mjs [--self-test]
 *   pnpm check:envelope-consistency
 *
 * Exit codes:
 *   0 — no violations (or self-test passed)
 *   1 — violations found, or self-test failed
 *   2 — document unreadable
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reportCorpus } from "./gate-corpus.mjs";

const SELF_TEST = process.argv.includes("--self-test");
const BACKEND_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const OPENAPI_PATH = join(BACKEND_ROOT, "openapi.json");
const SRC_ROOT = join(BACKEND_ROOT, "src");

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const REQUIRED_ERROR_COMPONENTS = ["BadRequest", "Unauthorized", "Forbidden", "NotFound"];
/**
 * Property names that say "this payload carries its position in a larger collection".
 *
 * `pageInfo`, `totalCount` and `nextAfter` were added 2026-09-03 with the source reader, each
 * because a real endpoint uses it as its cursor/count vocabulary and was otherwise reported as
 * having no pagination at all: `party/mirror/divergence` answers `{ …, truncated, nextAfter }`
 * against an `after` query param, and `nextAfter` is exactly the next cursor. This list is a
 * vocabulary, not an allowlist — nothing is on it that is not a pagination field.
 */
const PAGINATION_SIGNALS = [
  "nextCursor",
  "cursor",
  "total",
  "page",
  "hasMore",
  "meta",
  "pagination",
  "pageInfo",
  "totalCount",
  "totalPages",
  "nextAfter",
];

function has4xxRef(responses) {
  if (typeof responses !== "object" || responses === null) return false;
  for (const [code, resp] of Object.entries(responses)) {
    const num = parseInt(code, 10);
    if (num < 400 || num >= 600) continue;
    if (typeof resp === "object" && resp !== null && typeof resp["$ref"] === "string") return true;
  }
  return false;
}

function isPaginatedEndpoint(operation) {
  return (operation.parameters ?? []).some(
    (p) => typeof p === "object" && p !== null && ["cursor", "after", "page", "offset"].includes(String(p.name ?? "")),
  );
}

function has200Response(operation) {
  return Object.keys(operation.responses ?? {}).some((c) => parseInt(c, 10) >= 200 && parseInt(c, 10) < 300);
}

/**
 * Unwrap this API's standard `{ success, data }` response envelope.
 *
 * 2026-09-03 (v2 ticket 30). Every handler here answers inside that envelope, so the pagination
 * signal lives on `data`, never at the top level -- where the only properties are `success` and
 * `data`, neither of which is a signal. The rule below read the OUTER object and therefore
 * reported "no recognizable pagination signal" for endpoints that carry a perfectly good
 * `{ data, pagination }` one level in.
 *
 * That mattered more than a false positive normally would. This gate spent its whole life green
 * because there were 336 paginated GETs and NOT ONE of them carried a 2xx schema for it to read
 * -- it was passing over an empty corpus (see check:openapi-coverage, which reported 100%
 * response-schema coverage for the same reason). The moment real schemas appeared, the first
 * thing the gate did was misread them. Unwrapping is what lets the remaining violation be
 * believed.
 */
export function unwrapSuccessEnvelope(schema) {
  if (typeof schema !== "object" || schema === null) return schema;
  const props = schema.properties;
  if (typeof props !== "object" || props === null) return schema;
  if (!Object.prototype.hasOwnProperty.call(props, "success")) return schema;
  if (!Object.prototype.hasOwnProperty.call(props, "data")) return schema;
  const inner = props.data;
  return typeof inner === "object" && inner !== null ? inner : schema;
}

function schemaHasPaginationSignal(schema) {
  if (typeof schema !== "object" || schema === null) return false;
  const ref = schema["$ref"];
  if (typeof ref === "string") {
    return /paginated|page|cursor|collection/i.test(ref);
  }
  const props = schema.properties;
  if (typeof props !== "object" || props === null) return false;
  return PAGINATION_SIGNALS.some((s) => Object.prototype.hasOwnProperty.call(props, s));
}

export function findMissingErrorRefs(document) {
  const violations = [];
  for (const [pathTemplate, pathItem] of Object.entries(document.paths ?? {})) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      if (typeof operation !== "object" || operation === null) continue;
      if (!has4xxRef(operation.responses)) {
        violations.push({ method: method.toUpperCase(), path: pathTemplate });
      }
    }
  }
  return violations;
}

export function findMissingErrorComponents(document) {
  const components = document.components?.responses ?? {};
  return REQUIRED_ERROR_COMPONENTS.filter((name) => !Object.prototype.hasOwnProperty.call(components, name));
}

/**
 * How many paginated GETs exist, and how many of them declare a 2xx schema this gate can read.
 * The gap between the two is the reason this gate passed over an empty corpus for so long.
 */
export function countPaginatedGets(document) {
  let total = 0;
  let readable = 0;
  for (const pathItem of Object.values(document.paths ?? {})) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    const operation = pathItem["get"];
    if (typeof operation !== "object" || operation === null) continue;
    if (!isPaginatedEndpoint(operation)) continue;
    total++;
    const twoHundred = Object.entries(operation.responses ?? {}).find(
      ([c]) => parseInt(c, 10) >= 200 && parseInt(c, 10) < 300,
    );
    const content = twoHundred?.[1]?.content;
    if (typeof content !== "object" || content === null) continue;
    if (Object.values(content).some((mt) => typeof mt === "object" && mt !== null && typeof mt.schema === "object" && mt.schema !== null))
      readable++;
  }
  return { total, readable };
}

export function findUnpaginatedCollections(document) {
  const violations = [];
  for (const [pathTemplate, pathItem] of Object.entries(document.paths ?? {})) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (method !== "get") continue;
      if (typeof operation !== "object" || operation === null) continue;
      if (!isPaginatedEndpoint(operation)) continue;
      if (!has200Response(operation)) continue;

      const twoHundred = Object.entries(operation.responses ?? {}).find(([c]) => parseInt(c, 10) >= 200 && parseInt(c, 10) < 300);
      if (!twoHundred) continue;
      const [, resp] = twoHundred;
      if (typeof resp !== "object" || resp === null) continue;

      const content = resp.content;
      if (typeof content !== "object" || content === null) continue;

      for (const mediaType of Object.values(content)) {
        if (typeof mediaType !== "object" || mediaType === null) continue;
        const schema = mediaType.schema;
        if (typeof schema !== "object" || schema === null) continue;
        // The pagination signal lives on the payload, inside the { success, data } envelope.
        const payload = unwrapSuccessEnvelope(schema);
        if (payload.type === "array") {
          violations.push({ method: "GET", path: pathTemplate, issue: "paginated endpoint returns a bare array — expected a pagination envelope with cursor/total/meta" });
          break;
        }
        if (!schemaHasPaginationSignal(payload) && typeof payload["$ref"] !== "string") {
          violations.push({ method: "GET", path: pathTemplate, issue: "paginated endpoint 200 schema has no recognizable pagination signal (nextCursor, total, meta, etc.)" });
          break;
        }
      }
    }
  }
  return violations;
}

/* ------------------------------------------------------------------------------------------
 * THE SOURCE READER — the 334 endpoints the document cannot describe
 * ---------------------------------------------------------------------------------------- */

/** Brace-matched block starting at the first `{` at or after `from`. */
function braceBlock(text, from) {
  let open = from;
  while (open < text.length && text[open] !== "{") open++;
  if (open >= text.length) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return null;
}

/**
 * Byte ranges of nested arrow/function bodies, so a `return` inside a callback is not read as
 * the enclosing method's own return. Without this, `rows.map((r) => ({ month, tax }))` makes a
 * summary endpoint look like it returns `{ month, tax }`.
 */
export function nestedFunctionRanges(body) {
  const ranges = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "{") continue;
    let j = i - 1;
    while (j >= 0 && /\s/.test(body[j])) j--;
    const isArrow = j >= 1 && body[j] === ">" && body[j - 1] === "=";
    const isFunction =
      j >= 0 && body[j] === ")" && /\bfunction\b[^)]*$/.test(body.slice(Math.max(0, j - 200), j));
    if (!isArrow && !isFunction) continue;
    let depth = 0;
    for (let k = i; k < body.length; k++) {
      if (body[k] === "{") depth++;
      else if (body[k] === "}") {
        depth--;
        if (depth === 0) {
          ranges.push([i, k]);
          i = k;
          break;
        }
      }
    }
  }
  return ranges;
}

/** Every `return <expr>` written in this function's own body, callbacks excluded. */
export function returnExpressions(body) {
  const out = [];
  const nested = nestedFunctionRanges(body);
  for (const match of body.matchAll(/\breturn\b/g)) {
    if (nested.some(([a, b]) => match.index > a && match.index < b)) continue;
    let i = match.index + "return".length;
    const start = i;
    let depth = 0;
    for (; i < body.length; i++) {
      const c = body[i];
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) {
        if (depth === 0) break;
        depth--;
      } else if (c === ";" && depth === 0) break;
    }
    const expr = body.slice(start, i).trim();
    if (expr) out.push(expr);
  }
  return out;
}

/** Top-level property names of an object-literal expression, with spread elements flagged. */
export function objectLiteralKeys(expr) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (let i = 1; i < expr.length; i++) {
    const c = expr[i];
    if ("([{".includes(c)) { depth++; current += c; continue; }
    if (")]}".includes(c)) { if (depth === 0) break; depth--; current += c; continue; }
    if (c === "," && depth === 0) { parts.push(current); current = ""; continue; }
    current += c;
  }
  parts.push(current);
  const keys = [];
  for (const part of parts) {
    const named = /^\s*(\.\.\.)?\s*([A-Za-z0-9_]+)/.exec(part);
    if (!named) continue;
    keys.push({ spread: named[1] !== undefined, name: named[2], text: part.trim() });
  }
  return keys;
}

/** `const <name> = <expr>` — the last binding wins, which is the one a later return sees. */
export function localBinding(body, name) {
  const re = new RegExp(`\\b(?:const|let)\\s+${name}\\s*(?::[^=;]+)?=`, "g");
  let match = null;
  let found = null;
  while ((match = re.exec(body)) !== null) found = match;
  if (!found) return null;
  let i = found.index + found[0].length;
  const start = i;
  let depth = 0;
  for (; i < body.length; i++) {
    const c = body[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) { if (depth === 0) break; depth--; }
    else if (c === ";" && depth === 0) break;
  }
  return body.slice(start, i).trim();
}

const ENVELOPE_HELPERS = new Set([
  "buildCursorPage",
  "buildIdCursorPage",
  "buildListResponse",
  "buildTaskPage",
  "buildTimelinePage",
]);
/** Named envelope types; a declared return type is stronger evidence than a returned expression. */
const ENVELOPE_TYPE = /\b(?:CursorPage|IdCursorPage|ListResponse|TaskPage|TimelinePage|CursorListResponse)\s*</;
const ARRAY_TYPE = /^(?:Promise<\s*)?(?:readonly\s+)?(?:[A-Za-z0-9_$.<>, |]*\[\]|Array<[\s\S]*>)\s*>?$/;
/** Wrappers whose value IS the value of the callback handed to them. */
const CALLBACK_WRAPPER =
  /^(?:this\.[A-Za-z0-9_.]+\.)?(?:runInTenantTransaction|runInNewTenantTransaction|cachedVersioned|cachedVersionedForOrg|cached|withTenant)\s*\(/;

const MAX_HOPS = 8;

/** Every non-spec .ts file under src/, read once. */
function collectSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules") collectSourceFiles(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts") && !entry.endsWith(".spec.ts")) {
      out.push(full);
    }
  }
  return out;
}

export function createSourceIndex(root) {
  const files = new Set(collectSourceFiles(root));
  const text = new Map();
  const readSource = (file) => {
    if (!text.has(file)) text.set(file, readFileSync(file, "utf8"));
    return text.get(file);
  };

  /** Where a class is declared, by name. Only used to find the CONTROLLER; hops go by import. */
  const controllerFile = new Map();
  for (const file of files) {
    for (const m of readSource(file).matchAll(/^export\s+(?:abstract\s+)?class\s+([A-Za-z0-9_]+)/gm)) {
      if (!controllerFile.has(m[1])) controllerFile.set(m[1], file);
    }
  }

  /** `./x` / `../x/y` → the .ts file it names, or null for a package or an unresolvable path. */
  const resolveSpecifier = (fromFile, spec) => {
    if (!spec.startsWith(".")) return null;
    const base = resolve(dirname(fromFile), spec);
    for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
      if (files.has(candidate)) return candidate;
    }
    return null;
  };

  /**
   * Which file declares `name` as seen from `file`, and under what name it is declared THERE —
   * a local declaration, or the module it is imported from. This is what keeps the two
   * `WebhooksService` classes apart, and what makes `listAdjustments as runListAdjustments`
   * resolvable: the local alias is not the exported name, so searching the target module for
   * the alias finds nothing at all.
   *
   * Returns { file, exported } or null.
   */
  const symbolCache = new Map();
  const symbolFile = (file, name) => {
    const key = `${file} ${name}`;
    if (symbolCache.has(key)) return symbolCache.get(key);
    const src = readSource(file);
    let answer = null;
    if (new RegExp(`^(?:export\\s+)?(?:abstract\\s+)?(?:class|function|const)\\s+${name}\\b`, "m").test(src)) {
      answer = { file, exported: name };
    } else {
      for (const m of src.matchAll(/import\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g)) {
        const clause = m[2];
        const target = resolveSpecifier(file, m[3]);
        if (!target) continue;
        const namespace = /^\*\s+as\s+([A-Za-z0-9_]+)$/.exec(clause.trim());
        if (namespace) {
          if (namespace[1] === name) { answer = { file: target, exported: name }; break; }
          continue;
        }
        const braces = /\{([\s\S]*)\}/.exec(clause);
        if (braces) {
          for (const piece of braces[1].split(",")) {
            const bound = /(?:^|\s)(?:type\s+)?([A-Za-z0-9_]+)(?:\s+as\s+([A-Za-z0-9_]+))?\s*$/.exec(piece.trim());
            if (bound && (bound[2] ?? bound[1]) === name) answer = { file: target, exported: bound[1] };
          }
        }
        const defaultImport = /^([A-Za-z0-9_]+)\s*(?:,|$)/.exec(clause.trim());
        if (defaultImport && defaultImport[1] === name) answer = { file: target, exported: name };
        if (answer) break;
      }
    }
    symbolCache.set(key, answer);
    return answer;
  };

  return { files, readSource, controllerFile, symbolFile };
}

export function classBody(src, cls) {
  const m = new RegExp(`^export\\s+(?:abstract\\s+)?class\\s+${cls}\\b`, "m").exec(src);
  return m ? braceBlock(src, m.index) : null;
}

/**
 * Where a function's body starts, given the index just past its parameter list.
 *
 * "The next `{`" is wrong, and wrong in the direction that matters: a return type of
 * `Promise<{ gaps: Gap[]; nextCursor: number | null }>` puts a brace between the parameters
 * and the body, so the naive scan reads the TYPE as the body, finds no `return` in it and
 * reports a perfectly well-formed cursor envelope as unreadable. Five endpoints were lost
 * that way. A brace inside `<…>` is always part of the type; a brace at angle depth 0 is the
 * body unless another brace follows it, in which case it was an inline object return type.
 */
export function bodyStart(text, afterParams) {
  let i = afterParams;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== ":") return i;
  let angle = 0;
  for (i++; i < text.length; i++) {
    const c = text[i];
    if (c === "{") {
      const block = braceBlock(text, i);
      if (block === null) return i;
      if (angle > 0) { i += block.length - 1; continue; }
      let j = i + block.length;
      while (j < text.length && /\s/.test(text[j])) j++;
      return text[j] === "{" ? j : i;
    }
    if (c === "<") angle++;
    else if (c === ">") angle--;
    else if (c === ";") return i;
  }
  return i;
}

/** A method or arrow-property on a class body: its signature text and its body block. */
export function findMethod(body, method) {
  const re = new RegExp(
    `(?:^|\\n)\\s{2,4}(?:public\\s+|private\\s+|protected\\s+)?(?:readonly\\s+)?(?:async\\s+)?${method}\\s*(?:<[^>{]*>)?\\s*\\(`,
  );
  const m = re.exec(body);
  if (!m) return null;
  let i = m.index + m[0].length - 1;
  let depth = 0;
  for (; i < body.length; i++) {
    const c = body[i];
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) { i++; break; } }
  }
  const j = bodyStart(body, i);
  const sig = body.slice(m.index, j).replace(/\s+/g, " ").trim();
  if (body[j] !== "{") return { sig, body: "" };
  return { sig, body: braceBlock(body, j) ?? "" };
}

/** `private readonly svc: SomeService` — the declared type of each injected collaborator. */
export function collaboratorTypes(body) {
  const out = new Map();
  for (const m of body.matchAll(/(?:private|public|protected)\s+(?:readonly\s+)?([A-Za-z0-9_]+)\s*:\s*([A-Za-z0-9_]+)/g)) {
    if (!out.has(m[1])) out.set(m[1], m[2]);
  }
  return out;
}

/** The return-type annotation of a signature, or null when it is inferred. */
export function declaredReturnType(sig) {
  const m = /\)\s*:\s*(.+)$/.exec(sig);
  return m ? m[1].trim() : null;
}

const SCALAR_TYPE = /^(?:string|number|boolean|void|Buffer|Readable|StreamableFile)$/;

/**
 * Classify a payload from its declared return type alone. Returns null when the type says
 * nothing either way, which is the common case in a codebase that leans on inference.
 */
export function classifyReturnType(sig) {
  const type = declaredReturnType(sig);
  if (!type) return null;
  if (ENVELOPE_TYPE.test(type)) return { kind: "envelope", why: `declared return type ${type}` };
  const inner = /^Promise<([\s\S]*)>$/.exec(type);
  const bare = (inner ? inner[1] : type).trim();
  if (SCALAR_TYPE.test(bare)) return { kind: "scalar", why: `declared return type ${type}` };
  if (ARRAY_TYPE.test(bare)) return { kind: "bare-array", why: `declared return type ${type}` };
  // An inline object return type that names a cursor or a count IS the envelope declaration —
  // `Promise<{ gaps: Gap[]; nextCursor: number | null }>` is a contract, not an inference.
  if (bare.startsWith("{")) {
    const named = PAGINATION_SIGNALS.filter((s) => new RegExp(`\\b${s}\\s*\\??\\s*:`).test(bare));
    if (named.length > 0) return { kind: "envelope", why: `declared return type names ${named.join("/")}` };
  }
  return null;
}

/**
 * The type of ONE property of an inline object return type — `body` of
 * `Promise<{ filename: string; contentType: string; body: string }>`.
 *
 * `return file.body` is not the shape of `file`; it is the shape of one field of it, and reading
 * the object's own classification answers the wrong question. This was the last endpoint the
 * reader could not see (`GET /payroll/tax/export`, whose `file.body` is the CSV text), and it is
 * a general blind spot, not one endpoint's: a member access on a local binding says nothing at
 * all under the object-level rules. Returns null when the property is absent from the type or
 * its type says nothing — an unreadable member access must stay unreadable, not become a pass.
 */
export function classifyPropertyOfReturnType(sig, property) {
  const type = declaredReturnType(sig);
  if (type === null) return null;
  const inner = /^Promise<([\s\S]*)>$/.exec(type);
  const bare = (inner ? inner[1] : type).trim();
  if (!bare.startsWith("{")) return null;

  const at = new RegExp(`[{;]\\s*(?:readonly\\s+)?${property}\\s*\\??\\s*:`).exec(bare);
  if (at === null) return null;
  // The member's type runs to the `;` or `}` that closes it at nesting depth 0 — a nested
  // `{ … }` or `Array<…>` in between is part of this property, not the end of it.
  let depth = 0;
  let end = at.index + at[0].length;
  for (; end < bare.length; end++) {
    const c = bare[end];
    if ("([{<".includes(c)) depth++;
    else if (")]}>".includes(c)) { if (depth === 0) break; depth--; }
    else if (c === ";" && depth === 0) break;
  }
  const propertyType = bare.slice(at.index + at[0].length, end).trim();
  const why = `\`${property}\` is ${propertyType} on ${type}`;
  if (SCALAR_TYPE.test(propertyType)) return { kind: "scalar", why };
  if (ENVELOPE_TYPE.test(propertyType)) return { kind: "envelope", why };
  if (ARRAY_TYPE.test(propertyType)) return { kind: "bare-array", why };
  return null;
}

/**
 * The last method invoked at the top level of an expression.
 *
 * `rows.map(…)` is an array; `lines.map(…).join("\n")` is a CSV body, and a substring test for
 * `.map(` cannot tell them apart — it read every `buildCsv` export arm in the repository as a
 * paginated endpoint answering with a bare array.
 */
export function tailMethod(expr) {
  let depth = 0;
  let last = null;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if ("([{".includes(c)) { depth++; continue; }
    if (")]}".includes(c)) { depth--; continue; }
    if (depth !== 0 || c !== ".") continue;
    const call = /^\.([A-Za-z0-9_]+)\s*\(/.exec(expr.slice(i));
    if (call) last = call[1];
  }
  return last;
}

const ARRAY_TAIL = new Set(["map", "filter", "slice", "concat", "flatMap", "sort", "reverse", "findMany"]);
const SCALAR_TAIL = new Set(["join", "toString", "toFixed", "trim", "send", "json"]);

/**
 * Classify an expression as the payload of a paginated GET.
 *
 * `kind` is one of:
 *   envelope     — carries a pagination signal, directly or through a shared helper
 *   bare-array   — a list with no position information at all; this is the violation
 *   bare-object  — an object with no pagination signal (an aggregate, usually); reported only
 *   unresolved   — the reader could not follow it, and says so rather than guessing
 *
 * `deps` supplies the hop machinery so the classifier itself stays pure and self-testable.
 */
export function classifyPayloadExpression(expr, ctx, deps, hops = 0, trail = []) {
  if (hops > MAX_HOPS) return { kind: "unresolved", why: `hop limit reached at ${expr.slice(0, 50)}` };
  let e = expr.replace(/^await\s+/, "").trim();
  if (e.startsWith("(") && e.endsWith(")")) e = e.slice(1, -1).trim();
  if (e === "") return { kind: "unresolved", why: "empty return" };

  if (e.startsWith("{")) {
    const keys = objectLiteralKeys(e);
    const named = keys.filter((k) => !k.spread).map((k) => k.name);
    const signals = named.filter((n) => PAGINATION_SIGNALS.includes(n));
    if (signals.length > 0) return { kind: "envelope", why: `object literal carrying ${signals.join("/")}` };
    const spreads = keys.filter((k) => k.spread);
    for (const spread of spreads) {
      const inner = classifyPayloadExpression(spread.text.replace(/^\.\.\./, ""), ctx, deps, hops + 1, trail);
      if (inner.kind === "envelope") return inner;
    }
    if (spreads.length > 0) return { kind: "unresolved", why: `object literal with an unresolved spread: ${e.slice(0, 60)}` };
    return { kind: "bare-object", why: `object literal without a pagination signal: {${named.join(", ")}}` };
  }
  if (e.startsWith("[")) return { kind: "bare-array", why: "array literal" };

  const call = /^([A-Za-z0-9_]+)\s*\(/.exec(e);
  if (call && ENVELOPE_HELPERS.has(call[1])) return { kind: "envelope", why: `${call[1]}()` };

  // The tail of the chain is settled before any hop is attempted, because a trailing `.then(…)`
  // decides the value no matter what the chain in front of it is — and `this.db.select(…)…` on
  // one line otherwise reads as a hop into a collaborator called `db`.
  const tail = tailMethod(e);
  if (tail === "then") {
    // A drizzle builder that ends `.then((rows) => buildCursorPage(...))` builds its envelope
    // in the continuation, so the chain up to that point says nothing about the payload.
    const continuation = thenCallbackBody(e);
    if (continuation?.expr) return classifyPayloadExpression(continuation.expr, ctx, deps, hops + 1, trail);
    if (continuation?.block) {
      const returns = returnExpressions(continuation.block);
      if (returns.length > 0) return classifyReturns(returns, { ...ctx, body: continuation.block }, deps, hops + 1, trail);
    }
    return { kind: "unresolved", why: `.then(...) continuation not resolved: ${e.slice(0, 60)}` };
  }
  if (/^(?:this\.)?db\b/.test(e)) {
    if (tail === "findMany") return { kind: "bare-array", why: "drizzle findMany" };
    if (/\.select\s*\(/.test(e)) return { kind: "bare-array", why: "drizzle select builder" };
  }

  if (CALLBACK_WRAPPER.test(e)) {
    const callback = lastCallbackBody(e);
    if (callback?.expr) return classifyPayloadExpression(callback.expr, ctx, deps, hops + 1, trail);
    if (callback?.block) {
      const returns = returnExpressions(callback.block);
      if (returns.length > 0) return classifyReturns(returns, { ...ctx, body: callback.block }, deps, hops + 1, trail);
    }
    return { kind: "unresolved", why: `callback wrapper not resolved: ${e.slice(0, 60)}` };
  }

  const collaborator = /^this\.([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\s*\(/.exec(e);
  if (collaborator) {
    const declared = ctx.collaborators.get(collaborator[1]);
    if (!declared) return { kind: "unresolved", why: `this.${collaborator[1]} has no declared type` };
    return (
      deps.resolveClassMethod(ctx.file, declared, collaborator[2], hops + 1, trail) ?? {
        kind: "unresolved",
        why: `${declared}.${collaborator[2]} not found from ${ctx.cls}`,
      }
    );
  }

  const ownMethod = /^this\.([A-Za-z0-9_]+)\s*\(/.exec(e);
  if (ownMethod) {
    return (
      deps.resolveClassMethod(ctx.file, ctx.cls, ownMethod[1], hops + 1, trail) ?? {
        kind: "unresolved",
        why: `${ctx.cls}.${ownMethod[1]} not found`,
      }
    );
  }

  const namespaced = /^([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\s*\(/.exec(e);
  if (namespaced && !e.startsWith("this.")) {
    const viaNamespace = deps.resolveFunction(ctx.file, namespaced[2], hops + 1, trail, namespaced[1]);
    if (viaNamespace) return viaNamespace;
  }
  if (call) {
    const viaFunction = deps.resolveFunction(ctx.file, call[1], hops + 1, trail);
    if (viaFunction) return viaFunction;
  }

  if (tail !== null && SCALAR_TAIL.has(tail)) return { kind: "scalar", why: `.${tail}(...) — not a JSON collection` };
  if (tail !== null && ARRAY_TAIL.has(tail)) return { kind: "bare-array", why: `.${tail}(...) over a row set` };

  if (/^[A-Za-z0-9_]+$/.test(e) && ctx.body) {
    const bound = localBinding(ctx.body, e);
    if (bound) return classifyPayloadExpression(bound, ctx, deps, hops + 1, trail);
    return { kind: "unresolved", why: `identifier \`${e}\` is not bound in this body` };
  }

  // `return file.body` — one property of a local binding. Two ways to see it, and the object's
  // own classification is neither: when the binding is an object literal written right here the
  // property's value expression is in scope, and when it comes from a collaborator the property
  // is named in that method's declared return type. Anything else stays unresolved.
  const member = /^([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)$/.exec(e);
  if (member && ctx.body) {
    const bound = localBinding(ctx.body, member[1]);
    if (bound !== null) {
      if (bound.startsWith("{")) {
        const field = objectLiteralKeys(bound).find((k) => !k.spread && k.name === member[2]);
        if (field) {
          const colon = field.text.indexOf(":");
          const value = colon < 0 ? field.name : field.text.slice(colon + 1).trim();
          return classifyPayloadExpression(value, ctx, deps, hops + 1, trail);
        }
      }
      const producer = classifyPayloadExpression(bound, ctx, deps, hops + 1, trail);
      if (typeof producer.sig === "string") {
        const picked = classifyPropertyOfReturnType(producer.sig, member[2]);
        if (picked) return picked;
      }
    }
    return { kind: "unresolved", why: `\`${e}\` — no declared type for property \`${member[2]}\`` };
  }
  return { kind: "unresolved", why: e.replace(/\s+/g, " ").slice(0, 70) };
}

/** The body of the callback handed to a trailing `.then(...)`. */
export function thenCallbackBody(expr) {
  let depth = 0;
  let at = -1;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if ("([{".includes(c)) { depth++; continue; }
    if (")]}".includes(c)) { depth--; continue; }
    if (depth === 0 && c === "." && /^\.then\s*\(/.test(expr.slice(i, i + 12))) at = i;
  }
  if (at < 0) return null;
  const arrow = expr.indexOf("=>", at);
  return arrow < 0 ? null : arrowBody(expr, arrow + 2);
}

/** The body of the last `() => …` in an expression — how a cache/transaction wrapper is unwrapped. */
export function lastCallbackBody(expr) {
  const arrows = [...expr.matchAll(/\(\s*\)\s*=>/g)];
  if (arrows.length === 0) return null;
  return arrowBody(expr, arrows[arrows.length - 1].index + arrows[arrows.length - 1][0].length);
}

/** Whatever follows `=>` at `from`: a `{ … }` block, or the expression up to the call's close. */
function arrowBody(expr, from) {
  let i = from;
  while (i < expr.length && /\s/.test(expr[i])) i++;
  if (expr[i] === "{") {
    const block = braceBlock(expr, i);
    return block ? { block } : null;
  }
  let depth = 0;
  for (let k = i; k < expr.length; k++) {
    const c = expr[k];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) { if (depth === 0) return { expr: expr.slice(i, k).trim() }; depth--; }
    else if (c === "," && depth === 0) return { expr: expr.slice(i, k).trim() };
  }
  return { expr: expr.slice(i).trim() };
}

/**
 * A method with several returns is an envelope if ANY of them is one — an early
 * `if (!scope) return []` guard is a degenerate arm of the same list, not a separate contract.
 *
 * A `format=csv` arm is skipped rather than weighed: half the report handlers here branch into
 * `buildCsv(...)` before returning the JSON payload, and that arm's shape says nothing about
 * the JSON one. A handler whose EVERY arm is a non-JSON body is a download, and the pagination
 * envelope rule does not apply to it at all.
 */
export function classifyReturns(returns, ctx, deps, hops, trail) {
  let fallback = null;
  let sawScalar = false;
  for (const expr of returns) {
    const result = classifyPayloadExpression(expr, ctx, deps, hops, trail);
    if (result.kind === "envelope") return result;
    if (result.kind === "scalar") { sawScalar = true; continue; }
    if (fallback === null || fallback.kind === "unresolved") fallback = result;
  }
  if (fallback !== null) return fallback;
  if (sawScalar) return { kind: "scalar", why: "every return arm is a non-JSON body (export/download)" };
  return { kind: "unresolved", why: "no return statement" };
}

/** Wire the hop machinery to a source index. Returns { classifyOperation }. */
/**
 * The handler names an operationId could be naming.
 *
 * `@Version("2")` makes Nest's Swagger explorer append a `_v<version>` suffix to the
 * operationId — `UsersController_listUsersV2` is emitted as `UsersController_listUsersV2_v2`
 * — and there is no method by that name, so the source reader gave up and `GET /v2/users`
 * came out as NOT SCANNED. An unreadable endpoint is not a clean one, so a versioned route
 * silently left this gate's corpus the moment API versioning was configured, and the corpus
 * line read 338 of 339 while nothing said which rule had stopped applying.
 *
 * The literal name is tried FIRST: a handler may genuinely be called `somethingV2` — or even
 * end in `_v2` — and guessing the stripped name first would resolve the wrong method and
 * report its shape as this operation's.
 */
export function versionedMethodCandidates(method) {
  const stripped = method.replace(/_v[0-9]+$/, "");
  return stripped === method ? [method] : [method, stripped];
}

export function createSourceReader(index) {
  const memo = new Map();
  let chain = [];

  const resolveClassMethod = (fromFile, cls, method, hops, trail) => {
    const symbol = index.symbolFile(fromFile, cls);
    if (!symbol) return { kind: "unresolved", why: `class ${cls} is not imported into ${fromFile.split("/").pop()}` };
    const { file, exported } = symbol;
    const key = `${file}#${exported}.${method}`;
    if (trail.includes(key)) return { kind: "unresolved", why: `recursive at ${cls}.${method}` };
    // The memo replays the chain it recorded, so a second endpoint reaching the same service
    // reports the full path to the finding rather than a truncated one-hop trail.
    if (memo.has(key)) { chain.push(...memo.get(key).chain); return memo.get(key).result; }
    const body = classBody(index.readSource(file), exported);
    if (!body) return null;
    const found = findMethod(body, method);
    if (!found) return null;
    const chainStart = chain.length;
    chain.push(`${exported}.${method}`);
    // The signature travels with the verdict: a caller that returns one PROPERTY of this method's
    // value needs the type that names it, and by then the method is several hops behind.
    const remember = (result) => {
      const withSig = { ...result, sig: found.sig };
      memo.set(key, { result: withSig, chain: chain.slice(chainStart) });
      return withSig;
    };
    const byType = classifyReturnType(found.sig);
    if (byType) return remember(byType);
    const ctx = { cls: exported, file, collaborators: collaboratorTypes(body), body: found.body };
    const returns = returnExpressions(found.body);
    return remember(
      returns.length > 0
        ? classifyReturns(returns, ctx, deps, hops, [...trail, key])
        : { kind: "unresolved", why: "no return statement" },
    );
  };

  const resolveFunction = (fromFile, name, hops, trail, namespace) => {
    const symbol = index.symbolFile(fromFile, namespace ?? name);
    if (!symbol) return null;
    const { file } = symbol;
    // A namespace import (`ns.fn(...)`) keeps the member name; a direct one may be aliased, and
    // the module exports it under its own name.
    const exported = namespace === undefined ? symbol.exported : name;
    const src = index.readSource(file);
    const m = new RegExp(`^export\\s+(?:async\\s+)?function\\s+${exported}\\s*(?:<[^>]*>)?\\s*\\(`, "m").exec(src);
    if (!m) return null;
    const key = `${file}#fn:${exported}`;
    if (trail.includes(key)) return { kind: "unresolved", why: `recursive at ${exported}()` };
    if (memo.has(key)) { chain.push(...memo.get(key).chain); return memo.get(key).result; }
    const chainStart = chain.length;
    chain.push(`${exported}()`);
    let i = m.index + m[0].length - 1;
    let depth = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "(") depth++;
      else if (c === ")") { depth--; if (depth === 0) { i++; break; } }
    }
    const j = bodyStart(src, i);
    const remember = (result) => {
      memo.set(key, { result, chain: chain.slice(chainStart) });
      return result;
    };
    const byType = classifyReturnType(src.slice(m.index, j).replace(/\s+/g, " ").trim());
    if (byType) return remember(byType);
    const body = braceBlock(src, j) ?? "";
    const returns = returnExpressions(body);
    return remember(
      returns.length > 0
        ? classifyReturns(returns, { cls: exported, file, collaborators: new Map(), body }, deps, hops, [...trail, key])
        : { kind: "unresolved", why: `no return in ${exported}()` },
    );
  };

  const deps = { resolveClassMethod, resolveFunction };

  /** `ControllerClass_methodName` → the payload its handler answers with. */
  const classifyOperation = (operationId) => {
    const separator = operationId.indexOf("_");
    if (separator < 0) return { kind: "unresolved", why: `operationId ${operationId} has no method part`, chain: [] };
    const cls = operationId.slice(0, separator);
    const declaredMethod = operationId.slice(separator + 1);
    const file = index.controllerFile.get(cls);
    if (!file) return { kind: "unresolved", why: `controller ${cls} not found in src/`, chain: [] };

    const source = index.readSource(file);
    const clsBody = classBody(source, cls);
    const method =
      versionedMethodCandidates(declaredMethod).find(
        (candidate) => clsBody !== null && findMethod(clsBody, candidate) !== null,
      ) ?? declaredMethod;

    // A handler that takes `@Res()` and returns nothing writes the response itself — it never
    // reaches the serializer, so there is no JSON envelope for this rule to be about. Only the
    // no-return form: a `@Res({ passthrough: true })` handler that DOES return still answers
    // with JSON on its non-download arm.
    const handler = clsBody === null ? null : findMethod(clsBody, method);
    if (handler !== null && handler.sig.includes("@Res(") && returnExpressions(handler.body).length === 0) {
      return { kind: "scalar", why: "streams its own response through @Res()", chain: [`${cls}.${method}`] };
    }

    chain = [];
    const result = resolveClassMethod(file, cls, method, 0, []) ?? {
      kind: "unresolved",
      why: `${cls}.${method} not found`,
    };
    return { ...result, chain: chain.slice() };
  };

  return { classifyOperation };
}

/**
 * Read every paginated GET, from the declared contract where there is one and from the handler
 * source where there is not.
 *
 * Returns { total, scanned, bareArrays, unsignalled, unreadable } — `scanned` counts only the
 * operations whose payload shape was actually determined, so the corpus line cannot flatter it.
 */
export function readPaginatedGets(document, reader) {
  const out = { total: 0, scanned: 0, fromContract: 0, fromSource: 0, downloads: 0, bareArrays: [], unsignalled: [], unreadable: [] };
  for (const [pathTemplate, pathItem] of Object.entries(document.paths ?? {})) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    const operation = pathItem["get"];
    if (typeof operation !== "object" || operation === null) continue;
    if (!isPaginatedEndpoint(operation)) continue;
    out.total++;

    const twoHundred = Object.entries(operation.responses ?? {}).find(
      ([c]) => parseInt(c, 10) >= 200 && parseInt(c, 10) < 300,
    );
    const content = twoHundred?.[1]?.content;
    const declared =
      typeof content === "object" && content !== null
        ? Object.values(content).find((mt) => typeof mt === "object" && mt !== null && typeof mt.schema === "object" && mt.schema !== null)
        : undefined;
    if (declared) {
      // The declared contract is authoritative — findUnpaginatedCollections already judged it.
      out.scanned++;
      out.fromContract++;
      continue;
    }

    const operationId = typeof operation.operationId === "string" ? operation.operationId : "";
    const verdict = reader.classifyOperation(operationId);
    const entry = { path: pathTemplate, operationId, why: verdict.why, chain: verdict.chain.join(" → ") };
    if (verdict.kind === "bare-array") { out.scanned++; out.fromSource++; out.bareArrays.push(entry); }
    else if (verdict.kind === "envelope") { out.scanned++; out.fromSource++; }
    else if (verdict.kind === "bare-object") { out.scanned++; out.fromSource++; out.unsignalled.push(entry); }
    else if (verdict.kind === "scalar") { out.scanned++; out.fromSource++; out.downloads++; }
    else out.unreadable.push(entry);
  }
  return out;
}

if (SELF_TEST) {
  process.stdout.write("Running self-test...\n");
  let failed = false;

  const pass = (label) => process.stdout.write(`  [pass] ${label}\n`);
  const fail = (label, detail) => {
    process.stderr.write(`  [FAIL] ${label}: ${detail}\n`);
    failed = true;
  };

  const missingComponents = findMissingErrorComponents({ components: { responses: { BadRequest: {}, Unauthorized: {}, Forbidden: {}, NotFound: {} } } });
  if (missingComponents.length !== 0)
    fail("all-components-present", `expected 0 missing, got ${JSON.stringify(missingComponents)}`);
  else pass("all-components-present — all four required error components present");

  const partialComponents = findMissingErrorComponents({ components: { responses: { BadRequest: {} } } });
  if (partialComponents.length !== 3)
    fail("missing-components-detected", `expected 3 missing, got ${partialComponents.length}`);
  else pass("missing-components-detected — 3 missing error components detected");

  const goodDoc = { paths: { "/a": { get: { responses: { "200": { content: {} }, "400": { "$ref": "#/components/responses/BadRequest" } } } } } };
  if (findMissingErrorRefs(goodDoc).length !== 0)
    fail("error-ref-present-passes", "expected 0 violations for op with 4xx ref");
  else pass("error-ref-present-passes — 4xx $ref produces no violation");

  const badDoc = { paths: { "/a": { get: { responses: { "200": { content: {} } } } } } };
  if (findMissingErrorRefs(badDoc).length !== 1)
    fail("missing-error-ref-bites", "expected 1 violation for op without 4xx ref");
  else pass("missing-error-ref-bites — missing 4xx $ref is flagged");

  const paginatedGood = { paths: { "/things": { get: {
    parameters: [{ name: "cursor", in: "query" }],
    responses: { "200": { content: { "application/json": { schema: { properties: { data: {}, nextCursor: {} } } } } } },
  }}}};
  if (findUnpaginatedCollections(paginatedGood).length !== 0)
    fail("paginated-envelope-passes", "expected 0 violations for paginated response with nextCursor");
  else pass("paginated-envelope-passes — paginated response with nextCursor passes");

  // --- v2 ticket 30: the { success, data } envelope must be unwrapped before the signal check ---
  const envelopedGood = { paths: { "/things": { get: {
    parameters: [{ name: "page" }],
    responses: { "200": { content: { "application/json": { schema: { type: "object", properties: {
      success: { type: "boolean" },
      data: { type: "object", properties: { data: { type: "array" }, pagination: { type: "object" } } },
    } } } } } },
  } } } };
  if (findUnpaginatedCollections(envelopedGood).length !== 0)
    fail("envelope-unwrapped", "a { success, data } envelope whose data carries a pagination signal must pass");
  else pass("envelope-unwrapped — pagination signal inside the { success, data } envelope is found");

  // THE REAL FINDING SHAPE: unwrapping must not hide a bare array one level in.
  const envelopedBareArray = { paths: { "/things": { get: {
    parameters: [{ name: "page" }],
    responses: { "200": { content: { "application/json": { schema: { type: "object", properties: {
      success: { type: "boolean" },
      data: { type: "array", items: { type: "object" } },
    } } } } } },
  } } } };
  const ebaResult = findUnpaginatedCollections(envelopedBareArray);
  if (ebaResult.length !== 1)
    fail("envelope-bare-array-bites", "a bare array INSIDE the envelope must still be flagged");
  else if (!ebaResult[0].issue.includes("bare array"))
    fail("envelope-bare-array-reason", `must name the bare array; got ${JSON.stringify(ebaResult)}`);
  else pass("envelope-bare-array-bites — a bare array inside the envelope is flagged, and says why");

  // Unwrapping must not fire on a payload that merely happens to have a `data` property.
  const notAnEnvelope = { paths: { "/things": { get: {
    parameters: [{ name: "page" }],
    responses: { "200": { content: { "application/json": { schema: { type: "object", properties: {
      data: { type: "array" }, total: { type: "integer" },
    } } } } } },
  } } } };
  if (findUnpaginatedCollections(notAnEnvelope).length !== 0)
    fail("no-envelope-no-unwrap", "a top-level { data, total } payload has its own signal and must pass");
  else pass("no-envelope-no-unwrap — a payload without `success` is not unwrapped");

  const paginatedBad = { paths: { "/things": { get: {
    parameters: [{ name: "cursor", in: "query" }],
    responses: { "200": { content: { "application/json": { schema: { type: "array" } } } } },
  }}}};
  if (findUnpaginatedCollections(paginatedBad).length !== 1)
    fail("bare-array-bites", "expected 1 violation for paginated endpoint with bare array schema");
  else pass("bare-array-bites — bare array schema on a paginated endpoint is flagged");

  /* --- the source reader: every case below is a real shape that misled an earlier draft --- */

  const callbackBody = `{
    const rows = await this.db.select().from(t);
    return rows.map((row) => ({ month: row.month, tax: row.tax }));
  }`;
  const callbackReturns = returnExpressions(callbackBody);
  if (callbackReturns.length !== 1)
    fail("callback-returns-excluded", `expected 1 own return, got ${JSON.stringify(callbackReturns)}`);
  else if (!callbackReturns[0].startsWith("rows.map"))
    fail("callback-returns-excluded", `expected the method's own return, got ${callbackReturns[0]}`);
  else pass("callback-returns-excluded — a `return` inside a .map() callback is not the method's own");

  if (returnExpressions("{ const f = () => { return 1; }; }").length !== 0)
    fail("arrow-block-returns-excluded", "a return inside an arrow block belongs to the arrow");
  else pass("arrow-block-returns-excluded — an arrow block's return is not the enclosing method's");

  // The bug that hid five cursor envelopes: an inline object return type is not the body.
  const typedSig = "  async listGaps(orgId: string): Promise<{ gaps: Gap[]; nextCursor: number | null }> { return page; }";
  const typedMethod = findMethod(`\n${typedSig}\n`, "listGaps");
  if (typedMethod === null) fail("body-past-return-type", "method not found at all");
  else if (!typedMethod.body.includes("return page"))
    fail("body-past-return-type", `read the return TYPE as the body: ${typedMethod.body}`);
  else pass("body-past-return-type — a `Promise<{ … }>` return type is not mistaken for the body");

  if (classifyReturnType(typedMethod?.sig ?? "")?.kind !== "envelope")
    fail("inline-object-type-envelope", "a declared return type naming nextCursor is an envelope");
  else pass("inline-object-type-envelope — `Promise<{ …; nextCursor }>` is read as an envelope");

  if (classifyReturnType("async list(): Promise<GoalListItem[]>")?.kind !== "bare-array")
    fail("array-return-type-bites", "a declared `Promise<X[]>` return type is a bare array");
  else pass("array-return-type-bites — `Promise<X[]>` on a paginated GET is flagged");

  if (classifyReturnType("buildCursorPage(): CursorPage<Row>")?.kind !== "envelope")
    fail("envelope-return-type", "CursorPage<T> is the shared envelope type");
  else pass("envelope-return-type — CursorPage<T> is recognized");

  if (classifyReturnType("function buildCsv(h: string[], r: unknown[][]): string")?.kind !== "scalar")
    fail("string-return-type", "a `: string` return is a download body, not a collection");
  else pass("string-return-type — `: string` is a non-JSON body, not a bare array");

  // `return file.body` — the property's type, not the object's. The last blind spot in the corpus.
  const exportSig = "async exportCsv(orgId: string): Promise<{ filename: string; contentType: string; body: string }>";
  if (classifyPropertyOfReturnType(exportSig, "body")?.kind !== "scalar")
    fail("member-of-return-type", "`file.body` of a `{ …; body: string }` return is a download body");
  else pass("member-of-return-type — `x.body` is read from the property's type, not the object's");

  // The same rule must be able to BITE: a property that IS a row set is the violation.
  if (classifyPropertyOfReturnType("async load(): Promise<{ rows: Row[]; scanned: number }>", "rows")?.kind !== "bare-array")
    fail("member-of-return-type-bites", "a `Row[]` property is a bare array, not a pass");
  else pass("member-of-return-type-bites — a member whose type is `Row[]` is flagged");

  // A property the type does not name must stay unreadable rather than default to anything.
  if (classifyPropertyOfReturnType(exportSig, "items") !== null)
    fail("member-absent-stays-unresolved", "a property absent from the type says nothing");
  else pass("member-absent-stays-unresolved — an unnamed property is not answered by guessing");

  // The member's type ends at ITS own `;`, not at the first brace inside a nested one.
  if (classifyPropertyOfReturnType("f(): Promise<{ meta: { a: number }; page: CursorPage<Row> }>", "page")?.kind !== "envelope")
    fail("member-type-nesting", "a nested `{ … }` before the member must not truncate its type");
  else pass("member-type-nesting — a member's type is read past a nested object type");

  if (tailMethod('lines.map((r) => r.join(",")).join("\\n")') !== "join")
    fail("tail-method-join", "a chain ending .join() is a string, not an array");
  else pass("tail-method-join — `.map(…).join(…)` is read as a string, not a row set");

  if (tailMethod("rows.map((row) => ({ id: row.id }))") !== "map")
    fail("tail-method-map", "a chain ending .map() is an array");
  else pass("tail-method-map — a chain ending `.map(…)` is read as a row set");

  const keys = objectLiteralKeys("{ data, pagination: { limit }, ...rest }");
  if (keys.length !== 3 || keys[2].spread !== true)
    fail("object-literal-keys", `expected 3 keys with a spread last, got ${JSON.stringify(keys)}`);
  else pass("object-literal-keys — top-level keys are read past nested objects, spreads flagged");

  if (localBinding("{ const rows = await q(); const rows = await other(); }", "rows") !== "await other()")
    fail("local-binding-last-wins", "the binding a later return sees is the last one");
  else pass("local-binding-last-wins — the last `const` binding is the one resolved");

  const noHops = { resolveClassMethod: () => null, resolveFunction: () => null };
  const ctx = { cls: "X", file: "/x.ts", collaborators: new Map(), body: "" };
  const classify = (expr) => classifyPayloadExpression(expr, ctx, noHops).kind;

  const expressionCases = [
    ["{ data, pagination }", "envelope", "an object literal carrying `pagination`"],
    ["buildCursorPage(rows, limit, toPos)", "envelope", "the shared cursor helper"],
    ["buildListResponse(rows, total, filters)", "envelope", "the shared offset helper"],
    ["[]", "bare-array", "an empty array literal"],
    ["this.db.query.things.findMany({ limit })", "bare-array", "a drizzle findMany"],
    ["rows.map((r) => ({ id: r.id }))", "bare-array", "a projected row set"],
    ["{ acceptanceRate, resolutionRate }", "bare-object", "an aggregate with no pagination field"],
    ['lines.map((r) => r.join(",")).join("\\n")', "scalar", "a CSV body"],
    ["this.db.select({ id: t.id }).from(t).limit(l).then((rows) => buildCursorPage(rows, l, p))", "envelope",
      "a builder whose envelope is built in the .then() continuation"],
  ];
  for (const [expr, expected, label] of expressionCases) {
    const got = classify(expr);
    if (got !== expected) fail(`classify:${label}`, `expected ${expected}, got ${got} for ${expr}`);
    else pass(`classify — ${label} reads as ${expected}`);
  }

  // A `format=csv` arm must not decide the shape of the JSON arm, and must not hide it either.
  const mixedArms = classifyReturns(["buildCsv(headers, rows)", "{ items, total }"], ctx, noHops, 0, []);
  if (mixedArms.kind !== "envelope")
    fail("csv-arm-skipped", `a CSV arm beside a JSON envelope must not decide it; got ${mixedArms.kind}`);
  else pass("csv-arm-skipped — a download arm does not mask the JSON arm's envelope");

  const csvOnly = classifyReturns(['rows.map((r) => r.join(",")).join("\\n")'], ctx, noHops, 0, []);
  if (csvOnly.kind !== "scalar")
    fail("download-only", `a handler whose every arm is a download is not a collection; got ${csvOnly.kind}`);
  else pass("download-only — a handler with only non-JSON arms is not judged by this rule");

  /* --- a @Version()-suffixed operationId resolves to the handler it names --- */
  const versionCases = [
    ["listUsersV2_v2", ["listUsersV2_v2", "listUsersV2"], "a _v2 suffix is tried literally, then stripped"],
    ["listUsers", ["listUsers"], "an unsuffixed name produces exactly one candidate"],
    ["exportV2_v10", ["exportV2_v10", "exportV2"], "a multi-digit version suffix is stripped, the V2 in the name is not"],
  ];
  for (const [operationMethod, expected, label] of versionCases) {
    const got = versionedMethodCandidates(operationMethod);
    if (JSON.stringify(got) !== JSON.stringify(expected))
      fail(`versioned-method:${label}`, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
    else pass(`versioned-method — ${label}`);
  }
  if (versionedMethodCandidates("listUsersV2_v2")[0] !== "listUsersV2_v2")
    fail("versioned-method-order", "the literal name must be tried before the stripped one, or a real _v2 method resolves wrong");
  else pass("versioned-method — the literal name is tried before the stripped one");

  // The helper alone proves nothing about the WIRING: narrowing classifyOperation back to the
  // literal name leaves every case above passing while /v2/users drops out of the corpus
  // again. So this one drives the real reader over the real src/ and asserts the versioned
  // operationId Nest actually emits resolves to a shape.
  if (!existsSync(SRC_ROOT)) {
    fail("versioned-operation-resolves", `src/ not found at ${SRC_ROOT}`);
  } else {
    const liveReader = createSourceReader(createSourceIndex(SRC_ROOT));
    const suffixed = liveReader.classifyOperation("UsersController_listUsersV2_v2");
    const plain = liveReader.classifyOperation("UsersController_listUsersV2");
    if (plain.kind === "unresolved")
      fail("versioned-operation-premise", `UsersController.listUsersV2 must itself resolve, or this case is vacuous: ${plain.why}`);
    else if (suffixed.kind === "unresolved")
      fail("versioned-operation-resolves", `a @Version()-suffixed operationId must resolve to its handler; got unresolved: ${suffixed.why}`);
    else if (suffixed.kind !== plain.kind)
      fail("versioned-operation-resolves", `the suffixed id resolved to ${suffixed.kind}, the plain one to ${plain.kind} — they are the same handler`);
    else pass(`versioned-operation — UsersController_listUsersV2_v2 resolves to the same ${plain.kind} as the unsuffixed id`);
  }

  /* --- the anti-vacuity property: an endpoint the reader cannot read is NOT scanned --- */
  const sourceDoc = { paths: {
    "/readable": { get: { operationId: "C_a", parameters: [{ name: "cursor" }], responses: { "200": {} } } },
    "/bare": { get: { operationId: "C_b", parameters: [{ name: "page" }], responses: { "200": {} } } },
    "/opaque": { get: { operationId: "C_c", parameters: [{ name: "cursor" }], responses: { "200": {} } } },
  } };
  const verdicts = { C_a: { kind: "envelope", why: "ok", chain: [] }, C_b: { kind: "bare-array", why: "findMany", chain: [] }, C_c: { kind: "unresolved", why: "dynamic", chain: [] } };
  const read = readPaginatedGets(sourceDoc, { classifyOperation: (id) => verdicts[id] });
  if (read.total !== 3) fail("corpus-total", `expected a corpus of 3, got ${read.total}`);
  else if (read.scanned !== 2) fail("unresolved-not-scanned", `an unreadable endpoint must not count as scanned; got ${read.scanned}`);
  else if (read.bareArrays.length !== 1) fail("source-bare-array-bites", `expected 1 source violation, got ${read.bareArrays.length}`);
  else if (read.unreadable.length !== 1) fail("unreadable-named", "the unreadable endpoint must be named, not dropped");
  else pass("source-corpus — scanned counts only determined shapes; the unreadable one is named, not counted");

  if (failed) {
    process.stderr.write("\nSELF-TEST FAILED\n");
    process.exit(1);
  }
  process.stdout.write("\nSELF-TEST PASSED\n");
  process.exit(0);
}

if (!existsSync(OPENAPI_PATH)) {
  process.stderr.write(`check-envelope-consistency: openapi.json not found at ${OPENAPI_PATH}\n`);
  process.exit(2);
}

let document;
try {
  document = JSON.parse(readFileSync(OPENAPI_PATH, "utf8"));
} catch (err) {
  process.stderr.write(`check-envelope-consistency: failed to parse openapi.json: ${err.message}\n`);
  process.exit(2);
}

const missingComponents = findMissingErrorComponents(document);
const errorRefViolations = findMissingErrorRefs(document);
const paginationViolations = findUnpaginatedCollections(document);

// This gate was green for its whole life over 336 paginated GETs of which 2 carried a 2xx
// schema it could read. Report the corpus, and how much of it is actually readable, so that
// state can never again be indistinguishable from a clean one — and read the handlers, so the
// number being reported is a real one rather than an honest report of near-total blindness.
const contractOnly = countPaginatedGets(document);
if (!existsSync(SRC_ROOT)) {
  process.stderr.write(`check-envelope-consistency: src/ not found at ${SRC_ROOT} — the source reader cannot run\n`);
  process.exit(2);
}
const reader = createSourceReader(createSourceIndex(SRC_ROOT));
const paginatedGets = readPaginatedGets(document, reader);
reportCorpus({
  gate: "  check-envelope-consistency[pagination]",
  scanned: paginatedGets.scanned,
  total: paginatedGets.total,
  unit: "paginated GET",
});
process.stdout.write(
  `    ${String(paginatedGets.fromContract)} from a declared response contract, ` +
    `${String(paginatedGets.fromSource)} from the handler source ` +
    `(${String(paginatedGets.downloads)} of those are non-JSON downloads the rule does not cover; ` +
    `the document alone reaches ${String(contractOnly.readable)})\n`,
);

const total =
  missingComponents.length +
  errorRefViolations.length +
  paginationViolations.length +
  paginatedGets.bareArrays.length;

process.stdout.write(`check-envelope-consistency: response/error envelope analysis\n`);

if (missingComponents.length > 0) {
  process.stderr.write(`  MISSING COMPONENTS: ${missingComponents.join(", ")} — required shared error response components are absent\n`);
} else {
  process.stdout.write(`  shared error components: OK (${REQUIRED_ERROR_COMPONENTS.join(", ")})\n`);
}

if (errorRefViolations.length > 0) {
  process.stdout.write(`  MISSING ERROR REFS: ${String(errorRefViolations.length)} operation(s) with no 4xx $ref to shared component:\n`);
  for (const { method, path } of errorRefViolations.slice(0, 20)) {
    process.stdout.write(`    ${method.padEnd(6)} ${path}\n`);
  }
  if (errorRefViolations.length > 20) process.stdout.write(`    ... and ${String(errorRefViolations.length - 20)} more\n`);
} else {
  process.stdout.write(`  error envelope refs: OK — all operations reference shared error components\n`);
}

if (paginationViolations.length > 0) {
  process.stdout.write(`  PAGINATION ENVELOPE (${String(paginationViolations.length)} violation(s) — bare arrays on paginated endpoints):\n`);
  for (const { method, path, issue } of paginationViolations.slice(0, 20)) {
    process.stdout.write(`    ${method.padEnd(6)} ${path} — ${issue}\n`);
  }
  if (paginationViolations.length > 20) process.stdout.write(`    ... and ${String(paginationViolations.length - 20)} more\n`);
} else {
  process.stdout.write(`  pagination envelopes (declared contracts): OK\n`);
}

if (paginatedGets.bareArrays.length > 0) {
  process.stdout.write(
    `  PAGINATION ENVELOPE, READ FROM SOURCE (${String(paginatedGets.bareArrays.length)} violation(s) — the handler answers with a bare array):\n`,
  );
  for (const { path, why, chain } of paginatedGets.bareArrays) {
    process.stdout.write(`    GET    ${path} — ${why}\n           via ${chain}\n`);
  }
} else {
  process.stdout.write(`  pagination envelopes (handler source): OK\n`);
}

// Reported, never failed on: an endpoint whose query DTO carries `cursor`/`page` but whose
// handler answers with a scalar aggregate has a query-contract defect, not an envelope one, and
// this gate is not the place to arbitrate it. Named anyway, so it is not silently dropped.
if (paginatedGets.unsignalled.length > 0) {
  process.stdout.write(
    `  ADVISORY (${String(paginatedGets.unsignalled.length)} — paginated query params on a non-collection response; not counted):\n`,
  );
  for (const { path, why } of paginatedGets.unsignalled) process.stdout.write(`    GET    ${path} — ${why}\n`);
}

if (paginatedGets.unreadable.length > 0) {
  process.stdout.write(
    `  NOT SCANNED (${String(paginatedGets.unreadable.length)} — the source reader could not determine the payload shape):\n`,
  );
  for (const { path, why } of paginatedGets.unreadable) process.stdout.write(`    GET    ${path} — ${why}\n`);
}

process.stdout.write(`\n  Total violations: ${String(total)}\n`);

if (total > 0) {
  process.stderr.write(`check-envelope-consistency: FAIL — ${String(total)} envelope consistency violation(s).\n`);
  process.exit(1);
}

process.stdout.write(`  OK — response/error envelopes are consistent\n`);
process.exit(0);
