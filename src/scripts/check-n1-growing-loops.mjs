#!/usr/bin/env node
/**
 * Gate: no database or cache call inside a GROWING loop.  (ticket 21, §5.1 box 1)
 *
 * WHY THIS EXISTS ALONGSIDE check-db-call-count.mjs
 * -------------------------------------------------
 * That gate matches regular expressions against lines. It is useful and it is
 * kept, but it cannot decide the question the clause actually asks, because the
 * clause is not "is there a db call near a `for`" — it is "does this loop run
 * once per ROW". Those differ, and conflating them is how this box has twice
 * been given a denominator nobody could reproduce:
 *
 *   for (const adapter of PURGE_ADAPTERS)      // 9 adapters, forever 9 queries
 *   for (const row of rows)                    // one query per tenant row
 *
 * A line scanner sees the same shape. A parser sees that the first iterates an
 * imported array literal and the second iterates a query result.
 *
 * WHAT IT DECIDES
 * ---------------
 *   GROWING — the iteration count comes from data: a parameter, a query result,
 *             an await, a property, or a filter/map over any of those. A db or
 *             cache call inside one of these is one round trip per row. VIOLATION.
 *   FIXED   — the count is pinned by a literal reachable from the call site: an
 *             array/object literal, an in-file or IMPORTED const array, an enum,
 *             `i < <number>`. Constant round trips. Not a violation.
 *   PAGING  — the loop has no iteration source (`for (;;)`, `while`, `do`) or
 *             strides by a chunk (`i += CHUNK`). Each pass handles a whole PAGE,
 *             which is the bounded form §5.1 asks for. Not a violation.
 *
 * Three refinements are load-bearing and each was written after the measurement
 * without it was wrong:
 *   - `const rows = []` followed by `rows.push(x)` is GROWING, not "a literal of
 *     length 0" — ten real per-row loops read as fixed-size-zero without this.
 *   - a receiver named `...Cache` that is a `new Map()` is not a cache round
 *     trip; five in-process TTL sweeps were reported as N+1s without this.
 *   - `i += CHUNK` is the chunked bulk write box 3 ASKS for; its bound is
 *     `rows.length`, so a bound-only test scores the correct form as the defect
 *     it replaced.
 *
 * THE NUMBER BELOW IS A RATCHET, NOT A PASS
 * -----------------------------------------
 * MAX_GROWING_SITES starts at the measured count at the time this gate was
 * introduced. The repository is NOT clean: that many real growing-loop call
 * sites exist today. The gate fails when the number goes UP. It is a ratchet to
 * drive to zero, and a green run means "no new N+1 was added", not "there are
 * none". Lower it when you fix sites; never raise it to make a change fit.
 *
 * --self-test : bidirectional fixtures, then exit.
 * --json      : machine-readable findings.
 * --list      : print every GROWING site.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import ts from "typescript";

/**
 * Resolved from this file's own location, exactly as check-db-call-count.mjs does.
 * A hardcoded absolute path makes the gate scan the developer's checkout no matter
 * which tree it is run from — which silently defeats every hermetic proof, because
 * a defect planted in a temp tree is then judged against the untouched original.
 * An explicit argument still overrides, for the self-test and for tooling.
 */
const ROOT_ARG = process.argv.slice(2).find((a) => !a.startsWith("--"));
const MODULES_ROOT = new URL("../modules", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const COMMON_ROOT = new URL("../common", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const DB_ROOT = new URL("../db", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const ROOT = ROOT_ARG ?? MODULES_ROOT;
const JSON_OUT = process.argv.includes("--json");

/** Per-root floors for the two trees that joined this gate's corpus on 2026-09-03. */
const MIN_COMMON_FILES = 150;
const MIN_DB_FILES = 300;

/**
 * The gate reads THREE trees, not one.
 *
 * `src/modules` alone until 2026-09-03, so 97 growing sites over 2,173 files read as
 * a statement about the repository while `src/common` — every sweep, relay, workflow
 * and cache path in the system — and `src/db` were outside the corpus entirely. Three
 * more growing sites live in src/common, under the existing ratchet of 102.
 *
 * An explicit root argument still overrides and still scans exactly that one tree:
 * the hermetic proofs plant a defect in a temp copy and must judge THAT copy, so
 * silently unioning the real src/common into a temp-tree run would defeat them.
 */
const SCAN_ROOTS = ROOT_ARG
  ? [{ key: "", dir: ROOT_ARG, minFiles: 0, label: ROOT_ARG }]
  : [
      { key: "", dir: MODULES_ROOT, minFiles: 0, label: "src/modules" },
      { key: "@common", dir: COMMON_ROOT, minFiles: MIN_COMMON_FILES, label: "src/common" },
      { key: "@db", dir: DB_ROOT, minFiles: MIN_DB_FILES, label: "src/db" },
    ];

const EXCLUDED_PREFIXES = ["/crm/", "/inventory/"];

/* ------------------------------------------------------------------ files */
function collect(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e);
    let st; try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) collect(full, out);
    else if (
      st.isFile() && extname(e) === ".ts" &&
      !e.endsWith(".spec.ts") && !e.endsWith(".e2e-spec.ts") &&
      !e.endsWith(".module.ts") && !e.endsWith(".controller.ts") &&
      !e.endsWith(".decorator.ts") && !e.endsWith(".guard.ts") &&
      !e.endsWith(".interceptor.ts") && !e.endsWith(".filter.ts")
    ) out.push(full);
  }
  return out;
}

/* ------------------------------------------------------- db-call detection */
const DRIZZLE_ENTRY = new Set([
  "select", "selectDistinct", "insert", "update", "delete", "execute",
  "transaction", "refreshMaterializedView", "with",
]);
const CACHE_METHODS = new Set([
  "get", "set", "del", "delete", "hget", "hset", "mget", "wrap", "getOrSet",
  "lpush", "rpush", "incr", "expire", "invalidate", "sadd", "srem", "smembers",
]);
const HANDLE_NAMES = new Set([
  "db", "tx", "trx", "database", "executor", "countExecutor", "dbOrTx",
  "memberDb", "seedDb", "conn", "connection", "handle",
]);
const HANDLE_TYPE_RE = /\b(Db|TenantTx|NodePgDatabase|PgTransaction|DrizzleDb|Database|TxLike|DbOrTx)\b/;

/**
 * A `Map` named `...Cache` is NOT a cache round trip.
 *
 * `this.versionCache.delete(key)` inside a sweep loop is an in-process
 * `Map.prototype.delete` — no socket, no server. Matching a receiver on the
 * substring "cache" reported five such sweeps as N+1s, which is a false positive
 * in exactly the direction that makes a denominator look worse than it is.
 * Only a receiver whose declaration is NOT `new Map/Set/WeakMap/WeakSet` counts.
 */
function makeInMemoryCacheTest(sf) {
  const inMemory = new Set();
  const visit = (n) => {
    if ((ts.isPropertyDeclaration(n) || ts.isVariableDeclaration(n)) &&
        n.name && ts.isIdentifier(n.name) && n.initializer &&
        ts.isNewExpression(n.initializer) && ts.isIdentifier(n.initializer.expression) &&
        /^(Map|Set|WeakMap|WeakSet)$/.test(n.initializer.expression.text))
      inMemory.add(n.name.text);
    // `private deleteOrgEntries<T>(cache: Map<string, T>, ...)` — a parameter typed Map
    if (ts.isParameter(n) && n.type && n.name && ts.isIdentifier(n.name) &&
        /^(Map|Set|WeakMap|WeakSet|ReadonlyMap|ReadonlySet)\s*</.test(n.type.getText(sf).trim()))
      inMemory.add(n.name.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return (recvText) => {
    const leaf = recvText.replace(/^this\./, "").split(".").pop() ?? recvText;
    return inMemory.has(leaf);
  };
}

/** `this.db` / `db` / a parameter typed `Db | TenantTx` — the root of a query chain. */
function makeHandleTest(sf) {
  const localHandles = new Set();
  const visit = (n) => {
    if (
      (ts.isParameter(n) || ts.isVariableDeclaration(n)) &&
      n.type && HANDLE_TYPE_RE.test(n.type.getText(sf)) &&
      n.name && ts.isIdentifier(n.name)
    ) localHandles.add(n.name.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return (expr) => {
    if (ts.isIdentifier(expr))
      return HANDLE_NAMES.has(expr.text) || localHandles.has(expr.text);
    if (ts.isPropertyAccessExpression(expr) && expr.expression.kind === ts.SyntaxKind.ThisKeyword)
      return HANDLE_NAMES.has(expr.name.text) || localHandles.has(expr.name.text);
    return false;
  };
}

function rootOfChain(expr) {
  let cur = expr;
  for (;;) {
    if (ts.isPropertyAccessExpression(cur)) { cur = cur.expression; continue; }
    if (ts.isCallExpression(cur)) { cur = cur.expression; continue; }
    if (ts.isElementAccessExpression(cur)) { cur = cur.expression; continue; }
    if (ts.isNonNullExpression(cur) || ts.isParenthesizedExpression(cur)) { cur = cur.expression; continue; }
    return cur;
  }
}

/** The property name applied DIRECTLY to the handle, e.g. `this.db.select(` -> "select". */
function methodOnHandle(expr, isHandle) {
  let cur = expr;
  const names = [];
  for (;;) {
    // The handle test comes FIRST. `this.db` is itself a PropertyAccessExpression,
    // so unwinding before testing walked straight past it to the bare `this`
    // keyword, and every `this.db.select().from(t).where(...)` chain — 1,039 of
    // them in src/modules — returned null.
    if (isHandle(cur)) return names;
    if (ts.isPropertyAccessExpression(cur)) { names.unshift(cur.name.text); cur = cur.expression; continue; }
    if (ts.isCallExpression(cur)) { cur = cur.expression; continue; }
    if (ts.isElementAccessExpression(cur)) { names.unshift("[]"); cur = cur.expression; continue; }
    if (ts.isNonNullExpression(cur) || ts.isParenthesizedExpression(cur)) { cur = cur.expression; continue; }
    return null;
  }
}

/** Classify a CallExpression as a database or cache round trip. */
function dbCallKind(node, isHandle, sf, isInMemory = () => false) {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;

  // 1. handle.select( / handle.query.t.findFirst( / handle.execute(
  const chain = methodOnHandle(callee, isHandle);
  if (chain && chain.length > 0) {
    if (DRIZZLE_ENTRY.has(chain[0])) return { kind: "db", how: `handle.${chain[0]}` };
    if (chain[0] === "query" && chain.length >= 3 &&
        (chain[2] === "findFirst" || chain[2] === "findMany"))
      return { kind: "db", how: `handle.query.*.${chain[2]}` };
  }

  // 2. a helper RECEIVING the handle as an argument issues the query just as surely
  for (const arg of node.arguments) {
    const bare = ts.isNonNullExpression(arg) ? arg.expression : arg;
    if (isHandle(bare)) return { kind: "db", how: "helper(handle)" };
  }

  // 3. cache / redis round trip
  if (ts.isPropertyAccessExpression(callee) && CACHE_METHODS.has(callee.name.text)) {
    const recvText = callee.expression.getText(sf);
    if (/cache|redis/i.test(recvText) && !isInMemory(recvText))
      return { kind: "cache", how: `${recvText}.${callee.name.text}` };
  }
  return null;
}

/* -------------------------------------------------- loops + growing-ness */
const ITER_METHODS = new Set([
  "forEach", "map", "flatMap", "filter", "reduce", "reduceRight",
  "some", "every", "find", "findIndex", "sort", "flat",
]);

function isFunctionLike(n) {
  return n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));
}

/**
 * A loop node -> { body, source } where `source` is the expression being iterated
 * (undefined for while / bare for).
 */
function asLoop(node) {
  if (ts.isForOfStatement(node)) return { body: node.statement, source: node.expression, form: "for-of" };
  if (ts.isForInStatement(node)) return { body: node.statement, source: node.expression, form: "for-in" };
  if (ts.isForStatement(node)) return { body: node.statement, source: undefined, form: "for", forNode: node };
  if (ts.isWhileStatement(node)) return { body: node.statement, source: undefined, form: "while" };
  if (ts.isDoStatement(node)) return { body: node.statement, source: undefined, form: "do" };
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      ITER_METHODS.has(node.expression.name.text)) {
    const cb = node.arguments.find(isFunctionLike);
    if (cb) return { body: cb.body, source: node.expression.expression, form: `.${node.expression.name.text}` };
  }
  return null;
}

/**
 * Literal arrays / object keys / numeric bounds — in THIS file, and followed
 * across a relative import when the name is imported.
 *
 * Cross-file resolution is not decoration: `for (const a of PURGE_ADAPTERS)` is
 * a loop over a fixed constant list of adapters declared in a sibling file. With
 * in-file resolution only it reads as GROWING, and a fixed-size loop counted as
 * an N+1 is exactly the conflation that produced the denominator this pass was
 * sent to re-derive.
 */
const fileCache = new Map();
function parseFile(path) {
  if (fileCache.has(path)) return fileCache.get(path);
  let sf = null;
  try { sf = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS); }
  catch { sf = null; }
  fileCache.set(path, sf);
  return sf;
}
function resolveImport(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = join(dirname(fromFile), spec);
  for (const cand of [base + ".ts", join(base, "index.ts")]) {
    try { if (statSync(cand).isFile()) return cand; } catch { /* next */ }
  }
  return null;
}
const MUTATORS = new Set(["push", "unshift", "splice", "pop", "shift", "fill", "copyWithin", "set", "add"]);
function buildConstIndex(sf, depth = 0) {
  const idx = new Map();
  // `const rows = []` followed by `rows.push(x)` is a GROWING collection whose
  // initializer is an empty array literal. Binding it to that literal reported
  // "array literal of 0" — a fixed loop of size zero — for ten real per-row
  // loops, org-lifecycle's per-member `withIdentity` transaction among them.
  // A name that is ever mutated or reassigned resolves to nothing.
  const mutated = new Set();
  const findMutations = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) &&
        MUTATORS.has(n.expression.name.text) && ts.isIdentifier(n.expression.expression))
      mutated.add(n.expression.expression.text);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(n.left)) mutated.add(n.left.text);
    ts.forEachChild(n, findMutations);
  };
  findMutations(sf);
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && n.name && ts.isIdentifier(n.name) && n.initializer &&
        !mutated.has(n.name.text))
      idx.set(n.name.text, n.initializer);
    if (ts.isEnumDeclaration(n)) idx.set(n.name.text, n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (depth < 2) {
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !st.importClause?.namedBindings) continue;
      if (!ts.isNamedImports(st.importClause.namedBindings)) continue;
      if (!ts.isStringLiteral(st.moduleSpecifier)) continue;
      const target = resolveImport(sf.fileName, st.moduleSpecifier.text);
      if (!target) continue;
      const tsf = parseFile(target);
      if (!tsf) continue;
      const outer = buildConstIndex(tsf, depth + 1);
      for (const el of st.importClause.namedBindings.elements) {
        const srcName = (el.propertyName ?? el.name).text;
        if (!idx.has(el.name.text) && outer.has(srcName)) idx.set(el.name.text, outer.get(srcName));
      }
    }
  }
  return idx;
}

const FIXED = (n, why) => ({ growing: false, size: n, why });
const GROW = (why) => ({ growing: true, size: null, why });

/**
 * THE DISTINCTION THE DENOMINATOR TURNS ON.
 *
 * FIXED  = the iteration count is pinned by a literal visible at the call site
 *          (an array literal, an `as const` tuple, Object.keys of an object
 *          literal, `i < <number>`). A db call inside one of these runs a
 *          constant number of times and is NOT an N+1.
 * GROWING = the count comes from data — a parameter, a query result, a property,
 *          an await, a filter/map over any of those. One db call per row.
 */
function classifySource(source, constIdx, depth = 0) {
  if (!source) return GROW("no iteration source (while/for(;;))");
  if (depth > 4) return GROW("unresolved after 4 hops");

  let e = source;
  while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) ||
         ts.isSatisfiesExpression?.(e)) e = e.expression;

  if (ts.isArrayLiteralExpression(e)) {
    if (e.elements.some(ts.isSpreadElement)) return GROW("array literal with a spread");
    return FIXED(e.elements.length, `array literal of ${e.elements.length}`);
  }
  if (ts.isObjectLiteralExpression(e)) {
    if (e.properties.some(ts.isSpreadAssignment)) return GROW("object literal with a spread");
    return FIXED(e.properties.length, `object literal of ${e.properties.length}`);
  }
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
    const m = e.expression.name.text;
    const recv = e.expression.expression;
    if (recv.getText && recv.getText() === "Object" && (m === "keys" || m === "values" || m === "entries")) {
      const inner = e.arguments[0];
      if (inner) return classifySource(inner, constIdx, depth + 1);
    }
    // .filter/.map/.slice over something: growing-ness is inherited from the receiver
    if (["filter", "map", "flatMap", "slice", "concat", "sort", "reverse", "flat"].includes(m))
      return classifySource(recv, constIdx, depth + 1);
  }
  if (ts.isIdentifier(e)) {
    const init = constIdx.get(e.text);
    if (init && !ts.isEnumDeclaration(init)) return classifySource(init, constIdx, depth + 1);
    if (init && ts.isEnumDeclaration(init)) return FIXED(init.members.length, `enum of ${init.members.length}`);
    return GROW(`identifier ${e.text} not bound to a literal in-file`);
  }
  if (ts.isAwaitExpression(e)) return GROW("await result");
  if (ts.isPropertyAccessExpression(e)) return GROW(`property ${e.name.text}`);
  return GROW(ts.SyntaxKind[e.kind]);
}

/**
 * A STRIDE greater than one means the loop steps a CHUNK per iteration, not a row.
 *
 * `for (let o = 0; o < rows.length; o += AUDIT_INSERT_CHUNK)
 *    await tx.insert(t).values(rows.slice(o, o + AUDIT_INSERT_CHUNK));`
 *
 * is the chunked bulk insert box 3 ASKS for. Its bound is `rows.length`, which is
 * data-driven, so a bound-only test calls it GROWING and the correct form scores
 * as the defect it replaced. Only `i++` / `i += 1` iterates per row.
 */
function strideIsChunked(forNode) {
  const inc = forNode.incrementor;
  if (!inc) return false;
  if (ts.isPostfixUnaryExpression(inc) || ts.isPrefixUnaryExpression(inc)) return false;
  if (ts.isBinaryExpression(inc) && inc.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)
    return !(ts.isNumericLiteral(inc.right) && inc.right.text === "1");
  return false;
}

/** `for (let i = 0; i < 3; i++)` — a numeric-literal bound is fixed. */
function classifyForStatement(forNode, constIdx) {
  if (strideIsChunked(forNode))
    return { growing: "paging", size: null, why: "chunked stride (i += CHUNK) — one write per chunk" };
  const cond = forNode.condition;
  if (cond && ts.isBinaryExpression(cond)) {
    const rhs = cond.right;
    if (ts.isNumericLiteral(rhs)) return FIXED(Number(rhs.text), `i < ${rhs.text}`);
    if (ts.isIdentifier(rhs)) {
      const init = constIdx.get(rhs.text);
      if (init && ts.isNumericLiteral(init)) return FIXED(Number(init.text), `i < ${rhs.text} (=${init.text})`);
      if (init && ts.isPropertyAccessExpression(init)) return GROW(`i < ${rhs.text}`);
      return GROW(`i < ${rhs.text}`);
    }
    if (ts.isPropertyAccessExpression(rhs) && rhs.name.text === "length")
      return classifySource(rhs.expression, constIdx);
  }
  return GROW("for(;;) with a non-literal bound");
}

/* ----------------------------------------------------------------- ratchets */

/**
 * Growing-loop call sites in release scope. MEASURED 102 on 2026-09-03 (sixth
 * pass), down from 106 (fifth pass) and 124 before it. The four removed here are
 * the session tombstone fan-out, the payroll salary-component insert and the two
 * per-member UPDATEs the org archive/purge path issued.
 *
 * THIS IS A RATCHET, NOT A CLEAN BILL. 102 real sites remain and most of them
 * are genuine N+1s with a named batched form, listed in the ticket-21 report.
 * The gate fails when this goes UP. Lower it as sites are fixed.
 */
const MAX_GROWING_SITES = 102;

/**
 * Loop nodes the parser actually walked.
 *
 * The failure this whole area keeps producing is a detector that quietly stops
 * looking and reads as cleaner for it — counting FINDINGS cannot catch that,
 * because a narrower detector finds less. Counting what was INSPECTED can.
 * Measured 5,062 loop nodes; floor set ~5% below so ordinary churn does not red
 * the gate. It may only go UP.
 */
const MIN_LOOP_NODES = 4800;

/** Service files the scan must reach, so a wrong ROOT fails loudly. */
const MIN_FILES = 1800;

/* ------------------------------------------------------------------- scan */

export function scanTree(root, keyPrefix = "") {
  const files = collect(root);
  const results = [];
  let loopNodes = 0;

  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const rel = keyPrefix + file.slice(root.length).replace(/\\/g, "/");
    const found = scanSource(src, file, rel);
    loopNodes += found.loopNodes;
    results.push(...found.findings);
  }
  return { files: files.length, loopNodes, results };
}

export function scanSource(src, fileName, rel) {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const isHandle = makeHandleTest(sf);
  const isInMemory = makeInMemoryCacheTest(sf);
  const constIdx = buildConstIndex(sf);

  const loopStack = [];
  const findings = [];
  let loopNodes = 0;

  const visit = (node) => {
    const loop = asLoop(node);
    if (loop) {
      loopNodes++;
      loopStack.push({ node, loop, hit: null });
      if (loop.body) visit(loop.body);
      const frame = loopStack.pop();
      if (frame.hit) {
        const cls = loop.form === "for" && loop.forNode
          ? (loop.forNode.condition
              ? classifyForStatement(loop.forNode, constIdx)
              : { growing: "paging", size: null, why: "for(;;) cursor drain" })
          : (loop.form === "while" || loop.form === "do")
            ? { growing: "paging", size: null, why: `${loop.form} loop (cursor/keyset drain)` }
            : classifySource(loop.source, constIdx);
        findings.push({
          file: rel,
          loopLine: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          form: loop.form,
          callLine: frame.hit.line,
          how: frame.hit.how,
          kind: frame.hit.kind,
          growing: cls.growing,
          size: cls.size,
          why: cls.why,
          excluded: EXCLUDED_PREFIXES.some((prefix) => rel.startsWith(prefix)),
        });
      }
      if (loop.source) visit(loop.source);
      return;
    }
    if (ts.isCallExpression(node) && loopStack.length > 0) {
      const d = dbCallKind(node, isHandle, sf, isInMemory);
      if (d) {
        const frame = loopStack[loopStack.length - 1];
        if (!frame.hit)
          frame.hit = {
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            how: d.how,
            kind: d.kind,
          };
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return { loopNodes, findings };
}

/* -------------------------------------------------------------- self-test */

function countGrowing(src) {
  return scanSource(src, "/fixture/a.service.ts", "/fixture/a.service.ts")
    .findings.filter((f) => f.growing === true).length;
}
function classOf(src) {
  const f = scanSource(src, "/fixture/a.service.ts", "/fixture/a.service.ts").findings[0];
  return f === undefined ? "none" : String(f.growing);
}

function runSelfTests() {
  const growingCases = [
    ["a for-of over a parameter with a db call", "for (const r of rows) await this.db.select().from(t).where(eq(t.id, r.id));"],
    ["a braceless for calling a helper that receives the handle", "for (const r of rows)\n  await claimIdentifiers(this.db, r.id);"],
    ["Promise.all(map) issuing one update per id", "await Promise.all(ids.map((id) => this.db.update(t).set({ x: 1 }).where(eq(t.id, id))));"],
    ["a cache round trip per user", "for (const u of userIds) await this.cache.delete(key(u));"],
    ["a loop over an array that is push()ed into", "const acc = [];\nfor (const r of rows) acc.push(r.id);\nfor (const id of acc) await this.db.select().from(t).where(eq(t.id, id));"],
  ];
  for (const [label, body] of growingCases) {
    const n = countGrowing(`class S { async m(rows, ids, userIds) {\n${body}\n} }`);
    if (n < 1) { console.error(`SELF-TEST FAIL: ${label} — expected a GROWING finding, got ${n}`); process.exit(1); }
  }

  const notGrowing = [
    ["a loop over a 3-element array literal", `for (const k of ["a", "b", "c"]) await this.db.delete(t).where(eq(t.k, k));`, "false"],
    ["a loop over an in-file const array", "const A = [1, 2, 3];\nfor (const a of A) await this.db.delete(t).where(eq(t.a, a));", "false"],
    ["a for(;;) cursor drain", "for (;;) {\n  const page = await this.db.select().from(t).limit(500);\n  if (page.length < 500) break;\n}", "paging"],
    ["a chunked stride write", "for (let o = 0; o < rows.length; o += CHUNK)\n  await this.db.insert(t).values(rows.slice(o, o + CHUNK));", "paging"],
    ["a while keyset drain", "while (cursor) {\n  const page = await this.db.select().from(t);\n  cursor = page.at(-1)?.id;\n}", "paging"],
  ];
  for (const [label, body, expected] of notGrowing) {
    const got = classOf(`class S { async m(rows, cursor) {\n${body}\n} }`);
    if (got !== expected) { console.error(`SELF-TEST FAIL: ${label} — expected ${expected}, got ${got}`); process.exit(1); }
  }

  const clean = [
    ["a batched inArray read after a map", "const ids = rows.map((r) => r.id);\nawait this.db.select().from(t).where(inArray(t.id, ids));"],
    ["a loop with no db access", "for (const r of rows) total += r.amount;"],
    ["an in-process Map TTL sweep", "for (const [k, e] of this.versionCache) {\n  if (e.expiresAt <= now) this.versionCache.delete(k);\n}"],
  ];
  for (const [label, body] of clean) {
    const src = `class S {\n  versionCache = new Map();\n  async m(rows, now) {\n${body}\n  }\n}`;
    const n = scanSource(src, "/fixture/a.service.ts", "/fixture/a.service.ts").findings.length;
    if (n !== 0) { console.error(`SELF-TEST FAIL: ${label} — expected no finding, got ${n}`); process.exit(1); }
  }

  // The corpus itself. Three roots by default, exactly one when a root is named on
  // the command line — the hermetic proofs depend on the second half of that.
  if (!ROOT_ARG) {
    if (SCAN_ROOTS.length !== 3) {
      console.error(`SELF-TEST FAIL: expected 3 default scan roots, got ${String(SCAN_ROOTS.length)}`);
      process.exit(1);
    }
    for (const root of SCAN_ROOTS) {
      const found = collect(root.dir).length;
      if (found < root.minFiles) {
        console.error(
          `SELF-TEST FAIL: scan root ${root.label} yielded ${String(found)} files (expected >= ${String(root.minFiles)}) — it resolves to ${root.dir}`,
        );
        process.exit(1);
      }
    }
    const common = SCAN_ROOTS.find((r) => r.key === "@common");
    const rel = common.key + join(common.dir, "tenant/for-each-org.ts").slice(common.dir.length).replace(/\\/g, "/");
    if (rel !== "@common/tenant/for-each-org.ts") {
      console.error(`SELF-TEST FAIL: a src/common finding would be keyed "${rel}", not under @common`);
      process.exit(1);
    }
    if (EXCLUDED_PREFIXES.some((pre) => rel.startsWith(pre))) {
      console.error("SELF-TEST FAIL: an @common key was matched by the crm/inventory exclusion");
      process.exit(1);
    }
  }

  console.log("SELF-TEST PASS: 16 growing/fixed/paging/corpus checks passed");
}

/* ------------------------------------------------------------------- main */

function main() {
  if (process.argv.includes("--self-test")) { runSelfTests(); return; }

  let files = 0;
  let loopNodes = 0;
  const results = [];
  const perRoot = [];
  for (const root of SCAN_ROOTS) {
    const scanned = scanTree(root.dir, root.key);
    if (scanned.files < root.minFiles) {
      console.error(
        `ERROR: ${root.label} yielded only ${String(scanned.files)} service files (expected >= ${String(root.minFiles)}) — that root resolved to nothing or to the wrong tree: ${root.dir}`,
      );
      process.exitCode = 1;
      return;
    }
    perRoot.push({ ...root, scanned: scanned.files });
    files += scanned.files;
    loopNodes += scanned.loopNodes;
    results.push(...scanned.results);
  }
  if (files < MIN_FILES) {
    console.error(`ERROR: only ${String(files)} service files found across ${String(SCAN_ROOTS.length)} root(s) (expected >= ${String(MIN_FILES)}) — ROOT is wrong: ${ROOT}`);
    process.exitCode = 1;
    return;
  }

  const inScope = results.filter((r) => !r.excluded);
  const growing = inScope.filter((r) => r.growing === true);
  const fixed = inScope.filter((r) => r.growing === false);
  const paging = inScope.filter((r) => r.growing === "paging");

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ files, loopNodes, results }, null, 2));
    return;
  }

  console.log(`Parsed ${String(files)} service files, ${String(loopNodes)} loop nodes, across ${String(SCAN_ROOTS.length)} root(s):`);
  for (const root of perRoot) console.log(`  ${root.label.padEnd(12)}: ${String(root.scanned)} file(s)`);
  console.log(`${String(results.length - inScope.length)} finding(s) in excluded crm/inventory.`);
  console.log(`  GROWING (one round trip per row): ${String(growing.length)} site(s) across ${String(new Set(growing.map((g) => g.file)).size)} file(s)  [ratchet ${String(MAX_GROWING_SITES)}]`);
  console.log(`  FIXED   (literal-bounded):        ${String(fixed.length)} site(s)`);
  console.log(`  PAGING  (page/chunk per pass):    ${String(paging.length)} site(s)`);

  if (process.argv.includes("--list"))
    for (const g of [...growing].sort((a, b) => a.file.localeCompare(b.file)))
      console.log(`    ${g.file}:${String(g.loopLine)} -> ${String(g.callLine)}  ${g.how}  [${g.why}]`);

  let failed = false;

  if (loopNodes < MIN_LOOP_NODES) {
    console.error(`\nCOVERAGE REGRESSION: only ${String(loopNodes)} loop nodes were parsed (floor ${String(MIN_LOOP_NODES)}). A detector that walks less of the repository reports fewer findings and reads as cleaner, which is why this is a failure and not a note.`);
    failed = true;
  }

  if (growing.length > MAX_GROWING_SITES) {
    console.error(`\nRATCHET REGRESSION: ${String(growing.length)} growing-loop call site(s) against a ratchet of ${String(MAX_GROWING_SITES)}. A database or cache call inside a loop whose length comes from tenant data is one round trip per row. Batch it (inArray / a join / bulkUpdateFromValues / emitMany), or if the loop is genuinely bounded make that visible to the parser — a literal, an imported const array, or a chunked stride.`);
    failed = true;
  }

  if (!failed)
    console.log(`\nNo new growing-loop database or cache calls. ${String(growing.length)} site(s) remain against the ratchet of ${String(MAX_GROWING_SITES)} — this is a ratchet to drive to zero, not a clean repository.`);

  process.exitCode = failed ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) main();
