// scripts/check-list-response-projections.mjs
//
// Gate: @ResponseSchema list schema vs .select({}) projection drift in
// backend/src/modules/build/**
//
// Defect class (tickets STRE-55 / STRE-165, fixed 2026-09-19):
//   A list handler carries @ResponseSchema(xPageSchema) but the service
//   .select({ ... }) projects fewer columns than the item schema requires.
//   Because .nullable() keys are required (not .optional()), a missing key fails
//   Zod when the first real row arrives; the page silently works at zero rows.
//   The mirror: a projected key absent from the schema is silently stripped,
//   so counts render 0 forever.
//
// Two violation kinds reported:
//   required-not-projected — schema has a required scalar key the select omits
//   projected-not-declared  — select projects a key Zod will silently strip
//
// Design constraints:
//   - Static parse only. No import of the Nest app, no DB connection.
//   - A gate that resolves nothing exits 2 (INCONCLUSIVE). RESOLVED_FLOOR is the
//     minimum endpoint count for the gate to be conclusive.
//   - Multi-line sql`...` projection values are a single key in the AST.
//   - Bare .select() (no projection arg) → UNRESOLVED, not a false clean.
//   - Methods with no .select({...}) at all → UNRESOLVED.
//
// Precision rules (added 2026-09-19 to eliminate false positives):
//   1. bare-select-is-main: if the first .select() call in the method body is a
//      bare .select() (no args), the main query cannot be projected statically →
//      UNRESOLVED("bare-select-is-main"). Sub-query selects following it are NOT
//      the main projection.
//   2. spread-map-additions: if the method returns rows.map(r => ({ ...r, k1, k2 })),
//      the added keys k1, k2 ARE projected (computed post-query). They are added to
//      the effective projection before comparing against the schema.
//   3. map-reconstruction: if the method has a .map() whose callback returns a
//      fresh object literal WITHOUT a spread element (≥2 properties), the service
//      transforms its rows into a new shape we cannot trace statically →
//      UNRESOLVED("map-reconstruction").
//   4. return-path service call: in extractListHandlers, prefer the service call
//      that is directly returned (return this.svc.method()) over the first call
//      found. This avoids reading an access-check helper method's select instead of
//      the actual list method's select.
//   5. multi-select-ambiguous: if a method has >1 explicit select AND the spread-map
//      adds no keys (i.e. the first select is likely a helper, not the main query),
//      we cannot determine which select is authoritative → UNRESOLVED.
//
// Usage:
//   node scripts/check-list-response-projections.mjs
//   node scripts/check-list-response-projections.mjs --self-test

import { readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);
const ts = req("typescript");

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const SRC = join(REPO_ROOT, "src");
const BUILD_MODULE = join(SRC, "modules", "build");

// Raise this whenever new list endpoints are added to the build module.
const RESOLVED_FLOOR = 10;

// ── File walker ──────────────────────────────────────────────────────────────

function* walkTs(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === "__tests__") continue;
      yield* walkTs(full);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) {
      yield full;
    }
  }
}

// ── AST helpers ──────────────────────────────────────────────────────────────

function parseSf(filePath, source) {
  return ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
}

// Top-level: name → initializer node
function varDefs(sf) {
  const m = new Map();
  for (const s of sf.statements)
    if (ts.isVariableStatement(s))
      for (const d of s.declarationList.declarations)
        if (ts.isIdentifier(d.name) && d.initializer) m.set(d.name.text, d.initializer);
  return m;
}

// Walk a Zod call chain to detect .optional()
function isOptional(node) {
  let cur = node;
  while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
    if (cur.expression.name.text === "optional") return true;
    cur = cur.expression.expression;
  }
  return false;
}

const SCHEMA_MODS = new Set([
  "optional","nullable","default","refine","transform","describe",
  "readonly","strict","passthrough","catch","brand","pipe",
]);

// Peel modifier calls (.nullable(), .optional(), etc.) to find the base shape.
function peelMods(node) {
  let cur = node;
  while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression) &&
         SCHEMA_MODS.has(cur.expression.name.text))
    cur = cur.expression.expression;
  return cur;
}

// Check whether a value node resolves to z.array(...)
function isZArray(node) {
  const n = peelMods(node);
  return ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) &&
    n.expression.name.text === "array" && ts.isIdentifier(n.expression.expression) &&
    n.expression.expression.text === "z";
}

// Check whether a value node resolves to z.object(...)
function isZObject(node) {
  const n = peelMods(node);
  return ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) &&
    n.expression.name.text === "object" && ts.isIdentifier(n.expression.expression) &&
    n.expression.expression.text === "z";
}

// Extract keys from z.object({...}) returning {required, nonScalar, optional, all}.
// required   = scalar required keys  (what must appear in .select({}))
// nonScalar  = array/object required keys (typically assembled separately, skip in required check)
// optional   = keys with .optional()
// all        = every declared key
function extractZObjectKeys(callNode) {
  if (!ts.isCallExpression(callNode) || !callNode.arguments[0] ||
      !ts.isObjectLiteralExpression(callNode.arguments[0])) return null;
  const required = new Set(), nonScalar = new Set(), optional = new Set(), all = new Set();
  for (const p of callNode.arguments[0].properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const k = ts.isIdentifier(p.name) ? p.name.text :
              ts.isStringLiteral(p.name) ? p.name.text : null;
    if (!k) continue;
    all.add(k);
    if (isOptional(p.initializer)) {
      optional.add(k);
    } else if (isZArray(p.initializer) || isZObject(p.initializer)) {
      nonScalar.add(k);
    } else {
      required.add(k);
    }
  }
  return { required, nonScalar, optional, all };
}

// Get the base identifier of a method chain:  a.omit({}).extend({})  →  "a"
function chainBase(node) {
  let cur = node;
  while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression))
    cur = cur.expression.expression;
  return ts.isIdentifier(cur) ? cur.text : null;
}

// Get .omit / .extend / .pick operations, ordered innermost → outermost.
function chainOps(node) {
  const ops = [];
  let cur = node;
  while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
    const mn = cur.expression.name.text;
    if ((mn === "omit" || mn === "extend" || mn === "pick") &&
        cur.arguments[0] && ts.isObjectLiteralExpression(cur.arguments[0])) {
      const keys = new Set(), nonScalar = new Set(), optKeys = new Set();
      for (const p of cur.arguments[0].properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        const k = ts.isIdentifier(p.name) ? p.name.text :
                  ts.isStringLiteral(p.name) ? p.name.text : null;
        if (!k) continue;
        if (mn === "extend") {
          if (isOptional(p.initializer)) optKeys.add(k);
          else if (isZArray(p.initializer) || isZObject(p.initializer)) nonScalar.add(k);
          else keys.add(k);
        } else {
          keys.add(k);
        }
      }
      ops.unshift({ op: mn, keys, nonScalar, optKeys });
    }
    cur = cur.expression.expression;
  }
  return ops;
}

// ── Schema resolution ────────────────────────────────────────────────────────

// Returns true when a schema expression node is a list wrapper:
//   cursorPageSchema(X) | idCursorPageSchema(X) | itemsPagedSchema(X) | z.array(X)
// Follows one level of named identifier via schemaDefs.
function isListSchema(node, schemaDefs) {
  if (!node) return false;
  if (ts.isIdentifier(node)) {
    const d = schemaDefs.get(node.text);
    return d ? isListSchema(d, schemaDefs) : false;
  }
  if (!ts.isCallExpression(node)) return false;
  if (ts.isIdentifier(node.expression)) {
    const fn = node.expression.text;
    if (["cursorPageSchema","idCursorPageSchema","itemsPagedSchema"].includes(fn)) return true;
  }
  return (ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "array" &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "z");
}

// Resolve a schema expression to its item key sets.
// Returns { required, nonScalar, optional, all } or null if unresolvable.
function resolveSchema(node, schemaDefs, cache, depth = 0) {
  if (!node || depth > 12) return null;

  if (ts.isIdentifier(node)) {
    const name = node.text;
    if (cache.has(name)) return cache.get(name);
    const def = schemaDefs.get(name);
    if (!def) { cache.set(name, null); return null; }
    const result = resolveSchema(def, schemaDefs, cache, depth + 1);
    cache.set(name, result);
    return result;
  }

  if (!ts.isCallExpression(node)) return null;

  // List wrappers → recurse into item
  if (ts.isIdentifier(node.expression)) {
    const fn = node.expression.text;
    if (["cursorPageSchema","idCursorPageSchema","itemsPagedSchema"].includes(fn) && node.arguments[0])
      return resolveSchema(node.arguments[0], schemaDefs, cache, depth + 1);
  }
  if (ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "array" &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "z" &&
      node.arguments[0])
    return resolveSchema(node.arguments[0], schemaDefs, cache, depth + 1);

  // z.object({...})
  if (ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "object" &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "z")
    return extractZObjectKeys(node);

  // baseSchema.omit({}).extend({})  or similar chain
  const base = chainBase(node);
  if (base) {
    const baseDef = schemaDefs.get(base);
    if (!baseDef) return null;
    const br = resolveSchema(baseDef, schemaDefs, cache, depth + 1);
    if (!br) return null;
    const required = new Set(br.required);
    const nonScalar = new Set(br.nonScalar);
    const optional = new Set(br.optional);
    const all = new Set(br.all);
    for (const op of chainOps(node)) {
      if (op.op === "omit") {
        for (const k of op.keys) { required.delete(k); nonScalar.delete(k); optional.delete(k); all.delete(k); }
      } else if (op.op === "pick") {
        for (const k of [...required]) if (!op.keys.has(k)) required.delete(k);
        for (const k of [...nonScalar]) if (!op.keys.has(k)) nonScalar.delete(k);
        for (const k of [...optional]) if (!op.keys.has(k)) optional.delete(k);
        for (const k of [...all]) if (!op.keys.has(k)) all.delete(k);
      } else {
        for (const k of op.keys) { required.add(k); all.add(k); }
        for (const k of op.nonScalar) { nonScalar.add(k); all.add(k); }
        for (const k of op.optKeys) { optional.add(k); all.add(k); }
      }
    }
    return { required, nonScalar, optional, all };
  }

  // Peel modifier wrappers and retry
  if (ts.isPropertyAccessExpression(node.expression) &&
      SCHEMA_MODS.has(node.expression.name.text))
    return resolveSchema(node.expression.expression, schemaDefs, cache, depth + 1);

  return null;
}

// ── Map-pattern helpers ───────────────────────────────────────────────────────

// Unwrap a ParenthesizedExpression to its inner expression.
function unwrapParens(node) {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

// Given the body of an arrow/function callback, find object literals that have a
// SpreadAssignment and collect the additional named keys (non-spread properties).
// Handles concise body (expr), paren-wrapped concise body, and block body.
function collectSpreadObjectKeys(cbBody, out) {
  const expr = unwrapParens(cbBody);
  if (ts.isObjectLiteralExpression(expr)) {
    const hasSpread = expr.properties.some(p => ts.isSpreadAssignment(p));
    if (hasSpread) {
      for (const p of expr.properties) {
        if (ts.isSpreadAssignment(p)) continue;
        const k = ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)
          ? (ts.isIdentifier(p.name) ? p.name.text : null)
          : null;
        if (k) out.add(k);
      }
    }
    return;
  }
  if (ts.isBlock(cbBody)) {
    ts.forEachChild(cbBody, function walkBlock(n) {
      if (ts.isReturnStatement(n) && n.expression) {
        collectSpreadObjectKeys(n.expression, out);
      }
      ts.forEachChild(n, walkBlock);
    });
  }
}

// Given a method body node, collect all keys added by .map(r => ({ ...r, k1, k2 }))
// patterns (spread map with additional named properties).
function collectMapRemovedKeys(methodBody) {
  const removed = new Set();
  function visit(node) {
    if (ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "map" &&
        node.arguments.length >= 1) {
      const cb = node.arguments[0];
      const param = (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) ? cb.parameters[0]?.name : null;
      if (param && ts.isObjectBindingPattern(param)) {
        const rest = param.elements.find(e => e.dotDotDotToken && ts.isIdentifier(e.name));
        const body = unwrapParens(cb.body);
        if (rest && ts.isIdentifier(body) && body.text === rest.name.text)
          for (const e of param.elements) {
            if (e === rest) continue;
            const key = e.propertyName && ts.isIdentifier(e.propertyName) ? e.propertyName :
                        ts.isIdentifier(e.name) ? e.name : null;
            if (key) removed.add(key.text);
          }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(methodBody);
  return removed;
}

function collectMapAddedKeys(methodBody) {
  const added = new Set();
  function visit(node) {
    if (ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "map" &&
        node.arguments.length >= 1) {
      const cb = node.arguments[0];
      if (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) {
        collectSpreadObjectKeys(cb.body, added);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(methodBody);
  return added;
}

// Returns true if the callback body contains an object literal with ≥2 properties
// but NO SpreadAssignment (i.e. the service reconstructs a new shape from scratch).
function callbackBodyHasNonSpreadObject(cbBody) {
  const expr = unwrapParens(cbBody);
  if (ts.isCallExpression(expr)) return true;
  if (ts.isObjectLiteralExpression(expr)) {
    const hasSpread = expr.properties.some(p => ts.isSpreadAssignment(p));
    return !hasSpread && expr.properties.length >= 2;
  }
  if (ts.isBlock(cbBody)) {
    for (const stmt of cbBody.statements) {
      if (ts.isReturnStatement(stmt) && stmt.expression) {
        if (callbackBodyHasNonSpreadObject(stmt.expression)) return true;
      }
    }
  }
  return false;
}

// Returns true if the method body contains any .map(cb) where cb returns a fresh
// object literal WITHOUT a spread element (a full reconstruction the gate cannot trace).
function methodHasNonSpreadMap(methodBody) {
  let found = false;
  function visit(node) {
    if (found) return;
    if (ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "map" &&
        node.arguments.length >= 1) {
      const cb = node.arguments[0];
      if ((ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) &&
          callbackBodyHasNonSpreadObject(cb.body)) {
        found = true;
        return;
      }
    }
    if (!found) ts.forEachChild(node, visit);
  }
  visit(methodBody);
  return found;
}

// ── Service method table ─────────────────────────────────────────────────────

// Returns Map< "ClassName#methodName", { file, firstSelectKeys, firstSelectIsBare,
//   hasBareSel, selectCount, mapAddedKeys, hasNonSpreadMap } >
//
// firstSelectIsBare  — the first .select() call in the method body is bare (no args);
//                      the main query cannot be projected statically.
// mapAddedKeys       — keys added by spread-map patterns ({ ...row, k1, k2 }).
// hasNonSpreadMap    — method has .map() whose callback fully reconstructs the object
//                      without a spread; the return shape cannot be traced.
function buildServiceTable(dir, srcRoot) {
  const table = new Map();
  for (const file of walkTs(dir)) {
    if (!file.endsWith(".service.ts")) continue;
    const source = readFileSync(file, "utf8");
    // Skip files with unresolved git conflict markers.
    if (source.includes("<<<<<<<")) continue;
    const sf = parseSf(file, source);
    const relFile = srcRoot ? "src/" + relative(srcRoot, file).replace(/\\/g, "/") : file;

    function visitNode(n) {
      if (ts.isClassDeclaration(n)) {
        const className = n.name?.text;
        if (className) {
          for (const m of n.members) {
            if (!ts.isMethodDeclaration(m) || !m.body) continue;
            const mn = ts.isIdentifier(m.name) ? m.name.text : null;
            if (!mn) continue;
            const selects = [];
            let hasBareSel = false;
            let firstSelectIsBare = false;
            let firstSelectSeen = false;
            function findSel(node2) {
              if (ts.isCallExpression(node2) &&
                  ts.isPropertyAccessExpression(node2.expression) &&
                  node2.expression.name.text === "select") {
                if (node2.arguments.length === 0) {
                  hasBareSel = true;
                  if (!firstSelectSeen) {
                    firstSelectIsBare = true;
                    firstSelectSeen = true;
                  }
                } else if (ts.isObjectLiteralExpression(node2.arguments[0])) {
                  const keys = new Set();
                  for (const p of node2.arguments[0].properties)
                    if ((ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) || ts.isShorthandPropertyAssignment(p))
                      keys.add(p.name.text);
                  selects.push(keys);
                  if (!firstSelectSeen) firstSelectSeen = true;
                }
              }
              ts.forEachChild(node2, findSel);
            }
            findSel(m.body);
            table.set(`${className}#${mn}`, {
              file: relFile,
              firstSelectKeys: selects[0] ?? null,
              firstSelectIsBare,
              hasBareSel,
              selectCount: selects.length,
              mapAddedKeys: collectMapAddedKeys(m.body),
              mapRemovedKeys: collectMapRemovedKeys(m.body),
              hasNonSpreadMap: methodHasNonSpreadMap(m.body),
            });
          }
        }
      }
      ts.forEachChild(n, visitNode);
    }
    visitNode(sf);
  }
  return table;
}

// ── Controller handler extraction ────────────────────────────────────────────

// Returns handlers with @ResponseSchema wrapping a list schema.
// Each entry: { filePath, handlerName, line, schemaNode, serviceCall, ctorFields }
// serviceCall: { field, method } — prefers a directly-returned this.X.Y() call;
//   falls back to the first this.X.Y() call in the handler body.
// ctorFields: Map<fieldName, TypeName> from the constructor.
function extractListHandlers(filePath, schemaDefs) {
  const source = readFileSync(filePath, "utf8");
  // Skip files with unresolved git conflict markers.
  if (source.includes("<<<<<<<")) return [];
  const sf = parseSf(filePath, source);
  const results = [];

  function visitClass(node) {
    if (!ts.isClassDeclaration(node)) { ts.forEachChild(node, visitClass); return; }

    const ctorFields = new Map();
    for (const m of node.members) {
      if (!ts.isConstructorDeclaration(m)) continue;
      for (const p of m.parameters)
        if (ts.isIdentifier(p.name) && p.type && ts.isTypeReferenceNode(p.type)) {
          const tn = ts.isIdentifier(p.type.typeName) ? p.type.typeName.text : null;
          if (tn) ctorFields.set(p.name.text, tn);
        }
    }

    for (const m of node.members) {
      if (!ts.isMethodDeclaration(m) || !m.body) continue;
      const decs = ts.getDecorators(m);
      if (!decs) continue;
      const rsDec = decs.find(d =>
        ts.isCallExpression(d.expression) &&
        ts.isIdentifier(d.expression.expression) &&
        d.expression.expression.text === "ResponseSchema" &&
        d.expression.arguments.length > 0
      );
      if (!rsDec) continue;
      const schemaNode = rsDec.expression.arguments[0];
      if (!isListSchema(schemaNode, schemaDefs)) continue;

      const handlerName = ts.isIdentifier(m.name) ? m.name.text : "?";
      const line = sf.getLineAndCharacterOfPosition(m.name.getStart(sf)).line + 1;

      // Prefer the service call that is directly returned:
      //   return this.svc.method(...)
      //   return await this.svc.method(...)
      let serviceCall = null;
      function findReturnedSvc(n) {
        if (serviceCall) return;
        if (ts.isReturnStatement(n) && n.expression) {
          let expr = n.expression;
          if (ts.isAwaitExpression(expr)) expr = expr.expression;
          if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)) {
            const recv = expr.expression.expression;
            if (ts.isPropertyAccessExpression(recv) &&
                recv.expression.kind === ts.SyntaxKind.ThisKeyword) {
              serviceCall = { field: recv.name.text, method: expr.expression.name.text };
              return;
            }
          }
        }
        ts.forEachChild(n, findReturnedSvc);
      }
      findReturnedSvc(m.body);

      // Fall back to first this.X.Y() call if no return-path call found.
      if (!serviceCall) {
        function findAnySvc(n) {
          if (serviceCall) return;
          if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
            const recv = n.expression.expression;
            if (ts.isPropertyAccessExpression(recv) &&
                recv.expression.kind === ts.SyntaxKind.ThisKeyword)
              serviceCall = { field: recv.name.text, method: n.expression.name.text };
          }
          ts.forEachChild(n, findAnySvc);
        }
        findAnySvc(m.body);
      }

      results.push({ filePath, handlerName, line, schemaNode, serviceCall, ctorFields });
    }
  }
  visitClass(sf);
  return results;
}

// ── Core analysis ─────────────────────────────────────────────────────────────

function analyzeDir(buildDir, srcRoot) {
  // Build schema symbol table from every TS file in the dir.
  const schemaDefs = new Map();
  for (const file of walkTs(buildDir)) {
    const source = readFileSync(file, "utf8");
    if (source.includes("<<<<<<<")) continue;
    const sf = parseSf(file, source);
    for (const [name, initNode] of varDefs(sf))
      schemaDefs.set(name, initNode);
  }

  const serviceTable = buildServiceTable(buildDir, srcRoot);
  const cache = new Map();
  const violations = [], unresolved = [], analysed = [];
  let filesWalked = 0;

  for (const file of walkTs(buildDir)) filesWalked++;

  for (const file of walkTs(buildDir)) {
    if (!file.endsWith(".controller.ts")) continue;
    for (const h of extractListHandlers(file, schemaDefs)) {
      const relCtrl = srcRoot
        ? "src/" + relative(srcRoot, h.filePath).replace(/\\/g, "/")
        : h.filePath.replace(/\\/g, "/");
      const loc = `${relCtrl}:${h.line}`;
      const id = `${loc} [${h.handlerName}]`;

      const schemaKeys = resolveSchema(h.schemaNode, schemaDefs, cache);
      if (!schemaKeys) { unresolved.push({ id, reason: "schema-unresolvable" }); continue; }

      if (!h.serviceCall) { unresolved.push({ id, reason: "no-service-call" }); continue; }
      const { field, method } = h.serviceCall;
      const typeName = h.ctorFields.get(field);
      if (!typeName) { unresolved.push({ id, reason: `no-ctor-type-for:${field}` }); continue; }

      const svcKey = `${typeName}#${method}`;
      const svcInfo = serviceTable.get(svcKey);
      if (!svcInfo) { unresolved.push({ id, reason: `service-not-found:${svcKey}` }); continue; }

      // Precision rule 1: bare main select — cannot determine main query projection.
      if (svcInfo.firstSelectIsBare) {
        unresolved.push({ id, reason: "bare-select-is-main" });
        continue;
      }

      // Precision rule 3: non-spread map reconstruction — service transforms rows into
      // a new shape; the mapping between select keys and schema keys is opaque.
      if (svcInfo.hasNonSpreadMap) {
        unresolved.push({ id, reason: "map-reconstruction" });
        continue;
      }

      if (!svcInfo.firstSelectKeys) {
        unresolved.push({ id, reason: svcInfo.hasBareSel ? "bare-select" : "no-explicit-select" });
        continue;
      }

      // Precision rule 5: multiple selects with no spread additions — the first select
      // is likely a helper query (access check, sub-lookup), not the main projection.
      if (svcInfo.selectCount > 1 && svcInfo.mapAddedKeys.size === 0) {
        unresolved.push({ id, reason: "multi-select-ambiguous" });
        continue;
      }

      analysed.push(id);

      // Precision rule 2: spread-map additions — include keys added by .map(r => ({ ...r, k })).
      const effectiveProjection = new Set([
        ...svcInfo.firstSelectKeys,
        ...svcInfo.mapAddedKeys,
      ]);
      for (const k of svcInfo.mapRemovedKeys) effectiveProjection.delete(k);

      const missingReq = [...schemaKeys.required].filter(k => !effectiveProjection.has(k));
      const extraProj  = [...svcInfo.firstSelectKeys].filter(k => !schemaKeys.all.has(k) && !svcInfo.mapRemovedKeys.has(k));
      if (missingReq.length > 0 || extraProj.length > 0)
        violations.push({ id, svcMethod: `${typeName}.${method}`, svcFile: svcInfo.file, missingReq, extraProj });
    }
  }

  return { violations, unresolved, analysed, filesWalked };
}

// ── Gate runner ──────────────────────────────────────────────────────────────

function run() {
  console.log(`Scanning: ${BUILD_MODULE}`);
  const { violations, unresolved, analysed, filesWalked } = analyzeDir(BUILD_MODULE, SRC);

  console.log(`Files walked: ${filesWalked}  endpoints analysed: ${analysed.length}  unresolved: ${unresolved.length}`);

  if (unresolved.length > 0) {
    console.log("\nUnresolved (not checked — potential coverage gaps):");
    for (const u of unresolved) console.log(`  UNRESOLVED ${u.id}  reason: ${u.reason}`);
  }

  if (analysed.length < RESOLVED_FLOOR) {
    console.error(
      `\nINCONCLUSIVE — resolved ${analysed.length} endpoints, floor is ${RESOLVED_FLOOR}.`,
    );
    console.error("The file walker or schema resolver is not reaching the source tree.");
    console.error(`BUILD_MODULE path: ${BUILD_MODULE}`);
    return 2;
  }

  if (violations.length === 0) {
    console.log(`\nOK — ${analysed.length} list endpoints analysed, 0 violations.`);
    return 0;
  }

  console.error(`\n${violations.length} violation(s):\n`);
  for (const v of violations) {
    console.error(`FAIL  ${v.svcMethod}  ::  ${v.id}`);
    if (v.missingReq.length) console.error(`      required-not-projected: [${v.missingReq.join(", ")}]`);
    if (v.extraProj.length)  console.error(`      projected-not-declared:  [${v.extraProj.join(", ")}]`);
  }
  return 1;
}

// ── Self test ────────────────────────────────────────────────────────────────

function selfTest() {
  const tmpBase = join(tmpdir(), `slos-list-proj-${Date.now()}`);
  mkdirSync(join(tmpBase, "dto"), { recursive: true });
  let passed = 0, failed = 0;

  function check(label, ok, detail) {
    if (ok) { console.log(`  PASS  ${label}`); passed++; }
    else { console.error(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`); failed++; }
  }

  try {
    // KNOWN-BAD item schema: has scalar field "teamCount" that the service misses.
    writeFileSync(join(tmpBase, "dto", "bad-response.schemas.ts"), `
const badItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  teamCount: z.number().int(),
  optField: z.string().optional(),
  nestArr: z.array(z.object({ x: z.number() })),
});
const badListSchema = cursorPageSchema(badItemSchema);
`);

    // GOOD item schema: projection matches exactly.
    writeFileSync(join(tmpBase, "dto", "good-response.schemas.ts"), `
const goodItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  computedCount: z.number().int(),
});
const goodListSchema = cursorPageSchema(goodItemSchema);
`);

    // PROJECTED-NOT-DECLARED: service projects a key ("ghost") the schema doesn't declare.
    writeFileSync(join(tmpBase, "dto", "ghost-response.schemas.ts"), `
const ghostItemSchema = z.object({ id: z.number().int(), title: z.string() });
const ghostListSchema = z.array(ghostItemSchema);
`);

    // SPREAD-MAP: service has two selects (main + stats), returns rows.map with spread.
    // Schema requires base keys PLUS "statsCount" which is added by the spread map.
    // Gate must recognise statsCount as projected (precision rule 2) and report CLEAN.
    writeFileSync(join(tmpBase, "dto", "spread-response.schemas.ts"), `
const spreadItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  statsCount: z.number().int(),
});
const spreadListSchema = z.array(spreadItemSchema);
`);

    // Service: listBad misses teamCount; listGood is clean; listGhost has extra "ghost";
    // listWithSpread has two selects + spread-map (should be CLEAN after precision fix).
    writeFileSync(join(tmpBase, "fake.service.ts"), `
class FakeService {
  async listBad(orgId) {
    return this.db.select({ id: t.id, name: t.name }).from(t).limit(20);
  }
  async listGood(orgId) {
    return this.db.select({ id: t.id, name: t.name, computedCount: sql\`(SELECT 1)\` }).from(t).limit(20);
  }
  async listShorthand(orgId) {
    const computedCount = sql\`(SELECT 1)\`;
    return this.db.select({ id: t.id, name: t.name, computedCount }).from(t).limit(20);
  }
  async listOmitted(orgId) {
    const rows = await this.db.select({ id: t.id, title: t.title, cursorKey: t.cursorKey }).from(t).limit(20);
    return rows.map(({ cursorKey: _c, ...row }) => row);
  }
  async listOmittedRequired(orgId) {
    const rows = await this.db.select({ id: t.id, title: t.title }).from(t).limit(20);
    return rows.map(({ title, ...row }) => row);
  }
  async listViaHelper(orgId) {
    const rows = await this.db.select({ id: t.id, other: t.other }).from(t).limit(20);
    return rows.map((row) => this.toRow(row));
  }
  async listGhost(orgId) {
    return this.db.select({ id: t.id, title: t.title, ghost: t.ghost }).from(t).limit(20);
  }
  async listWithSpread(orgId) {
    const rows = await this.db.select({ id: t.id, name: t.name }).from(t).limit(20);
    const stats = await this.db.select({ itemId: t2.id, cnt: t2.count }).from(t2);
    const sm = new Map(stats.map(s => [s.itemId, s]));
    return rows.map(r => ({
      ...r,
      statsCount: Number(sm.get(r.id)?.cnt ?? 0),
    }));
  }
}
`);

    // Controller wiring all four.
    writeFileSync(join(tmpBase, "fake.controller.ts"), `
import { FakeService } from "./fake.service";
import { badListSchema } from "./dto/bad-response.schemas";
import { goodListSchema } from "./dto/good-response.schemas";
import { ghostListSchema } from "./dto/ghost-response.schemas";
import { spreadListSchema } from "./dto/spread-response.schemas";
class FakeController {
  constructor(private readonly svc: FakeService) {}
  @ResponseSchema(badListSchema)
  listBad(u) { return this.svc.listBad(u.orgId); }
  @ResponseSchema(goodListSchema)
  listGood(u) { return this.svc.listGood(u.orgId); }
  @ResponseSchema(goodListSchema)
  listShorthand(u) { return this.svc.listShorthand(u.orgId); }
  @ResponseSchema(ghostListSchema)
  listOmitted(u) { return this.svc.listOmitted(u.orgId); }
  @ResponseSchema(ghostListSchema)
  listOmittedRequired(u) { return this.svc.listOmittedRequired(u.orgId); }
  @ResponseSchema(ghostListSchema)
  listViaHelper(u) { return this.svc.listViaHelper(u.orgId); }
  @ResponseSchema(ghostListSchema)
  listGhost(u) { return this.svc.listGhost(u.orgId); }
  @ResponseSchema(spreadListSchema)
  listWithSpread(u) { return this.svc.listWithSpread(u.orgId); }
}
`);

    const result = analyzeDir(tmpBase, null);

    check("files walked > 0", result.filesWalked > 0, `got ${result.filesWalked}`);
    check("analysed >= 3", result.analysed.length >= 3, `got ${result.analysed.length}`);
    check("exactly 3 violations found", result.violations.length === 3,
      `got ${result.violations.length}: ${JSON.stringify(result.violations.map(v => ({ id: v.id, missingReq: v.missingReq, extraProj: v.extraProj })))}`);

    const badViol = result.violations.find(v => v.id.includes("listBad"));
    check("listBad: teamCount in required-not-projected",
      badViol?.missingReq?.includes("teamCount") === true,
      JSON.stringify(badViol));

    check("listBad: optField NOT in required-not-projected",
      !badViol?.missingReq?.includes("optField"),
      JSON.stringify(badViol?.missingReq));

    check("listBad: nestArr NOT in required-not-projected (nonScalar skipped)",
      !badViol?.missingReq?.includes("nestArr"),
      JSON.stringify(badViol?.missingReq));

    const ghostViol = result.violations.find(v => v.id.includes("listGhost"));
    check("listGhost: ghost in projected-not-declared",
      ghostViol?.extraProj?.includes("ghost") === true,
      JSON.stringify(ghostViol));

    check("listGood: no violation", !result.violations.some(v => v.id.includes("listGood")), "");

    check("listOmitted: a key a rest-destructuring map drops is neither projected nor stripped",
      !result.violations.some(v => v.id.includes("listOmitted]")),
      JSON.stringify(result.violations.filter(v => v.id.includes("listOmitted]"))));

    check("listOmittedRequired: a required key the map drops is required-not-projected",
      result.violations.find(v => v.id.includes("listOmittedRequired"))?.missingReq?.includes("title") === true,
      JSON.stringify(result.violations.filter(v => v.id.includes("listOmittedRequired"))));

    check("listViaHelper: a map through a helper call is unresolved, not a violation",
      !result.violations.some(v => v.id.includes("listViaHelper")) &&
        result.unresolved.some(u => u.id.includes("listViaHelper") && u.reason === "map-reconstruction"),
      JSON.stringify(result.unresolved.filter(u => u.id.includes("listViaHelper"))));

    check("listShorthand: a shorthand select key counts as projected",
      !result.violations.some(v => v.id.includes("listShorthand")),
      JSON.stringify(result.violations.filter(v => v.id.includes("listShorthand"))));

    check("listWithSpread: no violation (spread-map addition recognised)",
      !result.violations.some(v => v.id.includes("listWithSpread")),
      JSON.stringify(result.violations.filter(v => v.id.includes("listWithSpread"))));

  } finally {
    try { rmSync(tmpBase, { recursive: true }); } catch { /* ignore */ }
  }

  console.log(`\ncheck-list-response-projections self-test: ${passed} passed, ${failed} failed (13 assertions)`);
  return failed === 0 ? 0 : 1;
}

// ── Entry point ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
process.exit(args.includes("--self-test") ? selfTest() : run());
