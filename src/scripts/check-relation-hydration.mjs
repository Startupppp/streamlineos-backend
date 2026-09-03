#!/usr/bin/env node
/**
 * Gate: a `with:` block does not ship a whole related row.  (ticket 20, box 1)
 *
 * WHY THIS EXISTS ALONGSIDE check-query-projections.mjs
 * ----------------------------------------------------
 * That gate reads the TOP-LEVEL keys of a relational query and asks whether a
 * `columns:` is among them. It is deliberately blind to what is inside `with:`
 * — its own comment says a `columns:` nested in a `with:` "projects the RELATION,
 * not the row", and it tracks brace depth precisely so that a nested one does
 * NOT count. That is correct for the population it ratchets, and it leaves the
 * relation itself entirely unmeasured.
 *
 * The gap is not academic. In Drizzle, `with: { rel: true }` compiles to a
 * selection of EVERY column of the related table — verified against the
 * installed dialect, `buildRelationalQueryWithoutPK`, `if (config === true)`.
 * `with: { rel: { where: ... } }` does the same, because `config.columns` is
 * undefined and the else branch takes `Object.keys(tableConfig.columns)`. So a
 * read whose top-level projection is impeccable can still drag a whole row per
 * result across the wire, and the top-level gate scores it clean.
 *
 * Measured on the tree this gate was written against: 191 relation hydrations
 * carry no `columns:` at all.
 *
 * WHAT IT HARD-FAILS ON, AND WHY ONLY THAT
 * ----------------------------------------
 * An unprojected relation whose target table carries a CREDENTIAL-shaped column.
 * That clause needs no product decision, for the same reason a count path needs
 * none: nobody joins in a related row in order to read its bearer token, so
 * dropping it changes nothing anybody asked for.
 *
 * It found four such sites when it was written, all live:
 *   GET /hr/recruitment/jobs/:jobId returned every application's tracking_token,
 *   and GET /hr/recruitment/candidates/:candidateId returned that plus every
 *   interview's calendar_sync_token. tracking_token is a 32-byte randomBytes
 *   bearer credential; GET /public/application-status/:token is unauthenticated
 *   and resolves a candidate's name, email and job from it alone.
 *
 * The same credential-name pattern applied to the BASE table of a read is NOT
 * enforced, and that is a deliberate refusal rather than an oversight. Measured:
 * 84 base-table sites match, and reading them shows most are correct —
 * webhooks-dispatch must load the signing secret to sign with it, a survey
 * collector's token IS the shareable link the endpoint exists to return, and
 * webhooks.service.ts already strips its secret in the response map. A gate that
 * fires on 84 sites of which most are right does not get fixed; it gets an
 * allowance. Those sites are reported under --list as a CANDIDATE list.
 *
 * The users clause is checked here too, at an allowance of 0. It is already
 * covered by src/db/users-relation-projection.spec.ts, which is a REGEX
 * implementation; this is an independent AST one. Both measure 0 today. Two
 * implementations agreeing is the only corroboration available for a clause
 * whose whole claim is a negative.
 *
 * WHAT IT RATCHETS
 * ----------------
 * The total unprojected-relation population. Narrowing most of these changes a
 * response DTO, which is the product decision ticket 20 box 1 is BLOCKED on, so
 * this is a ratchet and not a pass: it stops the number climbing while the
 * decision is outstanding.
 *
 * COVERAGE FLOORS
 * ---------------
 * Findings-only ratchets cannot catch a detector that quietly stops looking: a
 * narrower scanner finds less and reads as an improvement. So the corpus is
 * ratcheted too — files parsed, tables and relations resolved, query call sites
 * found, relation entries walked. Any of them falling is a FAILURE.
 *
 * TWO FALSE-POSITIVE CLASSES WERE FOUND BY RUNNING THIS, AND BOTH ARE FIXED HERE
 * -----------------------------------------------------------------------------
 *   1. `columns: USER_COLS as const` read as unprojected, because an
 *      `as const` initializer is an AsExpression and not an object literal. That
 *      alone reported 14 phantom global-users hydrations — against a spec that
 *      correctly says there are none. A `columns:` KEY is a projection even when
 *      its value cannot be enumerated here.
 *   2. A projection shared across files (`SENDER_MEMBERSHIP_WITH_USER`) is
 *      invisible to a per-file constant map; six chat sites read as unresolved
 *      until an all-files map existed. Names that collide across files are NOT
 *      resolved — 80 do — so a collision degrades to "unresolved", never to a
 *      wrong answer.
 *
 * --self-test : run proof-of-failure fixtures and exit.
 * --list      : print every finding and the base-table candidate list.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";
import ts from "typescript";

/**
 * Resolved from import.meta.url, never hardcoded: a sibling gate shipped with an
 * absolute ROOT and scanned the developer's checkout no matter which tree it ran
 * from, which silently defeats every hermetic bite-proof. An explicit argument
 * still overrides, for the self-test and for tooling.
 */
const REPO =
  process.argv.slice(2).find((a) => !a.startsWith("--")) ??
  new URL("../../", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const SRC = join(REPO, "src");
const SCHEMA = join(SRC, "db", "schema");

/* ------------------------------------------------------------------ ratchets */

/** Unprojected relation hydrations. Measured at HEAD when this gate landed. */
const MAX_UNPROJECTED_RELATIONS = 191;

/** Relations to global `users` with no projection. CLOSED clause — stays at 0. */
const MAX_UNPROJECTED_USERS = 0;

/** Unprojected relations onto a table carrying a credential column. CLOSED — 0. */
const MAX_CREDENTIAL_RELATIONS = 0;

/** Corpus floors. A detector that walks less finds less and reads as cleaner. */
const MIN_FILES = 3400;
const MIN_TABLES = 850;
const MIN_RELATION_TABLES = 580;
const MIN_QUERY_CALLS = 1650;
const MIN_RELATION_ENTRIES = 530;

/**
 * A column whose name says it authenticates somebody.
 *
 * `token`-shaped AI accounting fields are excluded by name because they are
 * numbers, not credentials, and they are everywhere in the billing schema.
 * `webhookUrl`/`webhookEnabled` are configuration, not a secret.
 */
const CREDENTIAL_NAME =
  /(secret|token|password|passwd|apikey|credential|encrypted|privatekey|salt|otp|totp|refreshtoken|accesstoken|clientsecret|signingkey)/i;
const CREDENTIAL_EXEMPT =
  /^(tokenCount|tokensUsed|inputTokens|outputTokens|totalTokens|promptTokens|completionTokens|tokenUsage|tokensIn|tokensOut|estimatedTokens|maxTokens|tokenBudget|cachedTokens|webhookUrl|webhookId|webhookEvents|webhookEnabled|webhookReceived|credentialId|credentialUrl)$/;

const isCredential = (name) => CREDENTIAL_NAME.test(name) && !CREDENTIAL_EXEMPT.test(name);

/* ------------------------------------------------------------------ files */

function collect(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e);
    let st; try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) { if (e !== "node_modules") collect(full, out); }
    else if (st.isFile() && extname(e) === ".ts" && !e.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const isSpec = (f) =>
  f.endsWith(".spec.ts") || f.endsWith(".e2e-spec.ts") || f.includes(`${"/"}__tests__${"/"}`);

const parse = (file, text) =>
  ts.createSourceFile(file, text ?? readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

/* ------------------------------------------------------------------ AST helpers */

/** `{...} as const` / `satisfies X` / `( ... )` all wrap the literal we want. */
function unwrap(node) {
  let n = node;
  for (let i = 0; i < 10 && n; i++) {
    if (ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isParenthesizedExpression(n)) {
      n = n.expression;
      continue;
    }
    return n;
  }
  return n;
}

/** `jsonb("meta").notNull()` -> "jsonb"; the leftmost callee of a chain. */
function rootCallName(node) {
  let n = node;
  for (let i = 0; i < 60; i++) {
    if (ts.isCallExpression(n)) {
      if (ts.isIdentifier(n.expression)) return n.expression.text;
      if (ts.isPropertyAccessExpression(n.expression)) { n = n.expression.expression; continue; }
      return null;
    }
    if (ts.isPropertyAccessExpression(n)) { n = n.expression; continue; }
    return null;
  }
  return null;
}

function propertyName(p) {
  if (!p.name) return null;
  return ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
}

function objProp(obj, name) {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && propertyName(p) === name) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name;
  }
  return null;
}

/* ------------------------------------------------------------------ scan */

export function scan(repoRoot) {
  const src = join(repoRoot, "src");
  const schema = join(src, "db", "schema");
  const files = collect(src).filter((f) => !isSpec(f));

  /* --- tables: name -> { sqlName, columns: { tsName: typeFn } } --- */
  const tables = {};
  /* --- relations: tableVar -> { relName: { target, kind } } --- */
  const relmap = {};

  for (const file of collect(schema)) {
    if (isSpec(file)) continue;
    const sf = parse(file);
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
        const init = node.initializer;
        const e = init.expression;
        const callee = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null;
        if ((callee === "pgTable" || callee === "table") && init.arguments.length >= 2) {
          const [a0, a1] = init.arguments;
          if (ts.isStringLiteral(a0) && ts.isObjectLiteralExpression(a1)) {
            const columns = {};
            for (const p of a1.properties) {
              if (!ts.isPropertyAssignment(p)) continue;
              const k = propertyName(p);
              if (k) columns[k] = rootCallName(p.initializer) ?? "unknown";
            }
            tables[node.name.text] = { sqlName: a0.text, columns };
          }
        }
        if (callee === "relations" && init.arguments.length >= 2) {
          const t = init.arguments[0];
          if (ts.isIdentifier(t)) {
            relmap[t.text] = relmap[t.text] ?? {};
            const fn = init.arguments[1];
            const body = fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ? fn.body : null;
            const lit = body ? unwrap(body) : null;
            if (lit && ts.isObjectLiteralExpression(lit)) {
              for (const p of lit.properties) {
                if (!ts.isPropertyAssignment(p) || !ts.isCallExpression(p.initializer)) continue;
                const kind = ts.isIdentifier(p.initializer.expression) ? p.initializer.expression.text : null;
                if (kind !== "one" && kind !== "many") continue;
                const tgt = p.initializer.arguments[0];
                const key = propertyName(p);
                if (key && tgt && ts.isIdentifier(tgt)) relmap[t.text][key] = { target: tgt.text, kind };
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  /* --- object constants, per file and repo-wide --- */
  const parsed = new Map();
  const globalConsts = new Map();
  const collided = new Set();
  for (const file of files) {
    const sf = parse(file);
    parsed.set(file, sf);
    const perFile = new Map();
    const v = (n) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        const lit = unwrap(n.initializer);
        if (lit && ts.isObjectLiteralExpression(lit)) {
          perFile.set(n.name.text, lit);
          if (globalConsts.has(n.name.text) && globalConsts.get(n.name.text) !== lit) collided.add(n.name.text);
          globalConsts.set(n.name.text, lit);
        }
      }
      ts.forEachChild(n, v);
    };
    v(sf);
    sf.__consts = perFile;
  }

  const resolveObj = (node, consts) => {
    if (!node) return null;
    const n = unwrap(node);
    if (!n) return null;
    if (ts.isObjectLiteralExpression(n)) return n;
    if (ts.isIdentifier(n))
      return consts.get(n.text) ?? (collided.has(n.text) ? null : globalConsts.get(n.text)) ?? null;
    return null;
  };

  /* --- call sites --- */
  const findings = [];
  const baseCandidates = [];
  const unresolvedRelation = [];
  const unresolvedConfig = [];
  let queryCalls = 0;
  let relationEntries = 0;

  for (const file of files) {
    const sf = parsed.get(file);
    const consts = sf.__consts;
    const rel = relative(repoRoot, file);

    const descend = (baseTable, withObj, path, line, method) => {
      for (const p of withObj.properties) {
        let relName = null;
        let value = null;
        if (ts.isPropertyAssignment(p)) { relName = propertyName(p); value = p.initializer; }
        else if (ts.isShorthandPropertyAssignment(p)) { relName = p.name.text; value = p.name; }
        if (!relName) continue;
        relationEntries++;

        const link = relmap[baseTable]?.[relName];
        if (!link) { unresolvedRelation.push(`${rel}:${line} ${path}.${relName}`); continue; }
        const target = link.target;

        const cfg = resolveObj(value, consts);
        const unwrapped = unwrap(value);
        const isTrue = unwrapped !== null && unwrapped !== undefined && unwrapped.kind === ts.SyntaxKind.TrueKeyword;

        if (!cfg && !isTrue) { unresolvedConfig.push(`${rel}:${line} ${path}.${relName}`); continue; }

        // A `columns:` KEY is a projection even when its value is an alias this
        // scanner cannot enumerate. Calling `columns: USER_COLS as const`
        // unprojected produced 14 phantom findings against a spec that says
        // there are none, which is how that class was found.
        const projected = cfg !== null && objProp(cfg, "columns") !== null;

        if (!projected) {
          const t = tables[target];
          const credentials = t ? Object.keys(t.columns).filter(isCredential) : [];
          findings.push({
            file: rel, line, path: `${path}.${relName}`, target, kind: link.kind, method,
            shape: isTrue ? "true" : "object-without-columns",
            sqlName: t?.sqlName ?? null,
            columnCount: t ? Object.keys(t.columns).length : null,
            credentials,
            isUsers: target === "users",
          });
        }

        if (cfg) {
          const deeper = resolveObj(objProp(cfg, "with"), consts);
          if (deeper) descend(target, deeper, `${path}.${relName}`, line, method);
        }
      }
    };

    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        if (method === "findMany" || method === "findFirst") {
          const owner = node.expression.expression;
          if (ts.isPropertyAccessExpression(owner)) {
            const q = owner.expression;
            if (ts.isPropertyAccessExpression(q) && q.name.text === "query") {
              queryCalls++;
              const key = owner.name.text;
              const line = lineOf(sf, node);
              const arg = node.arguments[0];
              const obj = arg && ts.isObjectLiteralExpression(arg) ? arg : null;
              if (obj) {
                const withNode = resolveObj(objProp(obj, "with"), consts);
                if (withNode) descend(key, withNode, key, line, method);
                if (objProp(obj, "columns") === null) {
                  const t = tables[key];
                  const creds = t ? Object.keys(t.columns).filter(isCredential) : [];
                  if (creds.length) baseCandidates.push({ file: rel, line, method, sqlName: t.sqlName, credentials: creds });
                }
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  return {
    files: files.length,
    tables: Object.keys(tables).length,
    relationTables: Object.keys(relmap).length,
    queryCalls,
    relationEntries,
    collidedConstNames: collided.size,
    findings,
    baseCandidates,
    unresolvedRelation,
    unresolvedConfig,
  };
}

/* ------------------------------------------------------------------ self test */

function scanFixture(source) {
  // A fixture is scanned through the same descend() by writing it into a
  // throwaway in-memory source file that reuses the real schema model. Rather
  // than duplicate the machinery, the fixtures below assert the PARSER pieces
  // that decide a verdict, which is where every bug in this scanner has been.
  return parse("fixture.ts", source);
}

function selfTest() {
  let checks = 0;
  const fail = (msg) => { console.error(`SELF-TEST FAIL: ${msg}`); process.exit(1); };
  const ok = () => { checks++; };

  /* --- unwrap: the `as const` class that produced 14 phantom findings --- */
  {
    const sf = scanFixture(`const USER_COLS = { id: true } as const;`);
    let seen = null;
    const v = (n) => { if (ts.isVariableDeclaration(n) && n.initializer) seen = unwrap(n.initializer); ts.forEachChild(n, v); };
    v(sf);
    if (!seen || !ts.isObjectLiteralExpression(seen)) fail("`as const` was not unwrapped to its object literal");
    ok();
  }

  /* --- credential classifier, both directions --- */
  if (!isCredential("trackingToken")) fail("trackingToken not classified as a credential");
  ok();
  if (!isCredential("webhookSecret")) fail("webhookSecret not classified as a credential");
  ok();
  if (isCredential("inputTokens")) fail("inputTokens (an AI accounting count) classified as a credential");
  ok();
  if (isCredential("webhookUrl")) fail("webhookUrl (configuration) classified as a credential");
  ok();
  if (isCredential("credentialId")) fail("credentialId (a professional licence id on hr certifications) classified as a credential");
  ok();

  /* --- objProp finds a projection whatever the key spelling --- */
  {
    const sf = scanFixture(`const x = { columns: { id: true } };`);
    let lit = null;
    const v = (n) => { if (ts.isVariableDeclaration(n) && n.initializer) lit = unwrap(n.initializer); ts.forEachChild(n, v); };
    v(sf);
    if (!lit || objProp(lit, "columns") === null) fail("objProp did not find a top-level columns key");
    if (objProp(lit, "with") !== null) fail("objProp invented a with key that is not there");
    ok();
  }

  /* --- rootCallName unwinds a column chain --- */
  {
    const sf = scanFixture(`const t = { a: jsonb("a").$type().notNull() };`);
    let got = null;
    const v = (n) => { if (ts.isPropertyAssignment(n)) got = rootCallName(n.initializer); ts.forEachChild(n, v); };
    v(sf);
    if (got !== "jsonb") fail(`rootCallName returned ${String(got)} rather than jsonb`);
    ok();
  }

  /* --- end to end against the real tree --- */
  const r = scan(REPO);
  if (r.files < MIN_FILES) fail(`only ${r.files} source files discovered (floor ${MIN_FILES}) — REPO is wrong: ${REPO}`);
  ok();
  if (r.tables < MIN_TABLES) fail(`only ${r.tables} pgTable declarations resolved (floor ${MIN_TABLES})`);
  ok();
  if (r.queryCalls < MIN_QUERY_CALLS) fail(`only ${r.queryCalls} db.query find* call sites found (floor ${MIN_QUERY_CALLS})`);
  ok();
  if (r.unresolvedRelation.length !== 0) fail(`${r.unresolvedRelation.length} relation name(s) did not resolve against the relation map — the schema model is incomplete: ${r.unresolvedRelation.slice(0, 3).join(", ")}`);
  ok();
  if (r.findings.length === 0) fail("zero unprojected relations found — a vacuous pass; this repository had 191 when the gate was written");
  ok();
  if (r.findings.some((f) => f.credentials.length > 0)) fail("a credential-carrying unprojected relation exists but the classifier is meant to be at zero");
  ok();

  console.log(`SELF-TEST PASS: ${checks} checks`);
}

/* ------------------------------------------------------------------ main */

function main() {
  if (process.argv.includes("--self-test")) { selfTest(); return; }

  const r = scan(REPO);
  const users = r.findings.filter((f) => f.isUsers);
  const creds = r.findings.filter((f) => f.credentials.length > 0);

  console.log(`Corpus: ${r.files} files · ${r.tables} tables · ${r.relationTables} relation blocks · ${r.queryCalls} db.query find* call sites · ${r.relationEntries} relation entries walked.`);
  console.log(`Unprojected relation hydrations: ${r.findings.length} (ratchet ${MAX_UNPROJECTED_RELATIONS}).`);
  console.log(`  onto global users: ${users.length} (allowed ${MAX_UNPROJECTED_USERS})`);
  console.log(`  onto a table carrying a credential column: ${creds.length} (allowed ${MAX_CREDENTIAL_RELATIONS})`);
  console.log(`Unresolved relation names ${r.unresolvedRelation.length} · unresolved relation configs ${r.unresolvedConfig.length} · colliding const names not resolved ${r.collidedConstNames}.`);
  console.log(`Base-table credential CANDIDATES (reported, not enforced): ${r.baseCandidates.length}.`);

  if (process.argv.includes("--list")) {
    console.log("\n--- unprojected relation hydrations ---");
    for (const f of r.findings)
      console.log(`  ${f.method === "findMany" ? "LIST" : "ONE "} ${f.file}:${f.line} ${f.path} -> ${f.sqlName ?? "?"} (${f.columnCount ?? "?"} cols, ${f.kind}) ${f.shape}${f.credentials.length ? ` CREDENTIALS=[${f.credentials.join(",")}]` : ""}`);
    console.log("\n--- base-table credential candidates (NOT enforced: most are correct) ---");
    for (const c of r.baseCandidates)
      console.log(`  ${c.method === "findMany" ? "LIST" : "ONE "} ${c.file}:${c.line} -> ${c.sqlName} [${c.credentials.join(",")}]`);
  }

  let failed = false;

  if (r.files < MIN_FILES || r.tables < MIN_TABLES || r.relationTables < MIN_RELATION_TABLES || r.queryCalls < MIN_QUERY_CALLS || r.relationEntries < MIN_RELATION_ENTRIES) {
    console.error(`\nCOVERAGE REGRESSION: the corpus shrank (files ${r.files}/${MIN_FILES}, tables ${r.tables}/${MIN_TABLES}, relation blocks ${r.relationTables}/${MIN_RELATION_TABLES}, query calls ${r.queryCalls}/${MIN_QUERY_CALLS}, relation entries ${r.relationEntries}/${MIN_RELATION_ENTRIES}). A detector that walks less of the repository reports fewer findings and reads as an improvement, which is why this is a failure and not a note.`);
    failed = true;
  }

  if (r.unresolvedRelation.length > 0) {
    console.error(`\n${r.unresolvedRelation.length} relation name(s) in a with: block do not exist in any relations() declaration. Either the schema model here is incomplete, or the query will raise at build time — Drizzle throws "Cannot read properties of undefined (reading 'referencedTable')" for exactly this:`);
    for (const u of r.unresolvedRelation.slice(0, 20)) console.error(`  UNRESOLVED-RELATION  ${u}`);
    failed = true;
  }

  if (creds.length > MAX_CREDENTIAL_RELATIONS) {
    console.error(`\n${creds.length} unprojected relation(s) hydrate a table carrying a credential column, against an allowance of ${MAX_CREDENTIAL_RELATIONS}. Nobody joins in a related row in order to read its bearer token, so narrowing this changes no contract and needs no product decision. Prefer an exclusion (columns: { theToken: false }) when the rest of the shape must be preserved:`);
    for (const f of creds) console.error(`  CREDENTIAL-HYDRATION  ${f.file}:${f.line} ${f.path} -> ${f.sqlName} [${f.credentials.join(",")}]`);
    failed = true;
  }

  if (users.length > MAX_UNPROJECTED_USERS) {
    console.error(`\n${users.length} unprojected relation(s) hydrate the GLOBAL users row, against an allowance of ${MAX_UNPROJECTED_USERS}. users is not tenant-scoped and carries totpSecret, emergencyContact, dateOfBirth and metadata:`);
    for (const f of users) console.error(`  USERS-HYDRATION  ${f.file}:${f.line} ${f.path}`);
    failed = true;
  }

  if (r.findings.length > MAX_UNPROJECTED_RELATIONS) {
    console.error(`\nRATCHET REGRESSION: unprojected relation hydrations rose ${MAX_UNPROJECTED_RELATIONS} -> ${r.findings.length}. \`with: { rel: true }\` selects EVERY column of the related table, and so does \`with: { rel: { where: ... } }\` — an object without a columns: key takes the same branch. Narrowing most of these changes a response DTO, which is the product decision ticket 20 box 1 is blocked on, so this number is not required to fall; it may not climb while that decision is outstanding.`);
    failed = true;
  }

  if (!failed)
    console.log(`\nNo credential or global-users relation hydration, and the population did not grow. ${r.findings.length} unprojected relation(s) remain against a ratchet of ${MAX_UNPROJECTED_RELATIONS} — this is a ratchet, not a clean repository.`);

  process.exitCode = failed ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) main();
