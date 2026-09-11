#!/usr/bin/env node
/**
 * Find test doubles that stub methods their real service does not have.
 *
 * This exists because of `crm-mcp.service.ts`. Six MCP tools called four
 * services through a `Record<string, Function>` cast, probing for `list`,
 * `findOne` and `preview` — names no service has. The doubles in the specs were
 * named for those same three, so they satisfied the dead branch and the suite
 * was green across six broken tools, one of which had never once returned data.
 *
 * A double built from the caller's imagination can only ever confirm the caller.
 * The defect is invisible to tsc (`useValue` is `any`) and invisible to jest
 * (the double answers). It is only visible by comparing the double's keys with
 * the real class, which is what this does.
 *
 * Reports a key as suspect only when the provider token resolves to a class this
 * script actually read. Anything it cannot resolve is counted and named, never
 * silently dropped — an unresolved import is a hole in the census, not a pass.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const ROOT = resolve(process.argv[2] ?? "src");

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (e === "node_modules" || e === "dist") continue;
      walk(p, out);
    } else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Balanced-brace slice starting at the `{` at or after `from`. */
function braceSlice(text, from) {
  const start = text.indexOf("{", from);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return { start, end: i, body: text.slice(start + 1, i) };
    }
  }
  return null;
}

/** Top-level keys of an object literal body (depth-0 `name:` only). */
function topLevelKeys(body) {
  const keys = [];
  let depth = 0;
  let line = "";
  for (const ch of body) {
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
    if (ch === "\n") {
      const m = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*:/.exec(line);
      if (m && depth === 0) keys.push(m[1]);
      line = "";
    } else line += ch;
  }
  const m = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*:/.exec(line);
  if (m && depth === 0) keys.push(m[1]);
  return keys;
}

/**
 * Method names of a class INCLUDING everything it inherits.
 *
 * The `extends` walk is not a nicety. `EmailService extends EmailSendersBase`
 * and `sendEmail` is declared on the base, so a census reading only the class's
 * own file reported every `sendEmail` double in the repo as bogus — eight false
 * positives, all agreeing with the answer the census was written to find.
 */
function classMethodsIn(text) {
  const names = new Set();
  const re = /^  (?:public |private |protected |readonly |static |override )*(?:async |get |set )*([A-Za-z_$][\w$]*)\s*[(<]/gm;
  const RESERVED = new Set(["constructor", "if", "for", "while", "switch", "catch", "return", "await"]);
  let m;
  while ((m = re.exec(text))) if (!RESERVED.has(m[1])) names.add(m[1]);
  const re2 = /^  (?:public |private |protected |static |override )*(?:readonly )?([A-Za-z_$][\w$]*)\s*[:=]/gm;
  while ((m = re2.exec(text))) names.add(m[1]);
  return names;
}

/** True only when this file really declares `class <token>`; a token is not a class. */
function declaresClass(text, token) {
  return new RegExp(`export\\s+(?:abstract\\s+)?class\\s+${token}\\b`).test(text);
}

function methodsWithInheritance(file, token, seen = new Set()) {
  if (seen.has(file)) return new Set();
  seen.add(file);
  const text = readFileSync(file, "utf8");
  const names = classMethodsIn(text);
  const ext = new RegExp(`class\\s+${token}\\s+extends\\s+([A-Za-z_$][\\w$]*)`).exec(text);
  if (ext) {
    const baseFile = resolveImportIn(file, ext[1], text);
    if (baseFile) for (const n of methodsWithInheritance(baseFile, ext[1], seen)) names.add(n);
    else UNRESOLVED_BASES.add(`${token} extends ${ext[1]}`);
  }
  return names;
}

const UNRESOLVED_BASES = new Set();

function resolveImportIn(specFile, ident, specText) {
  const re = new RegExp(`import\\s*\\{[^}]*\\b${ident}\\b[^}]*\\}\\s*from\\s*["']([^"']+)["']`);
  const m = re.exec(specText);
  if (!m) return null;
  let rel = m[1];
  if (!rel.startsWith(".")) return null;
  const base = resolve(dirname(specFile), rel);
  for (const cand of [base + ".ts", join(base, "index.ts")]) {
    try {
      statSync(cand);
      return cand;
    } catch {}
  }
  return null;
}

const files = walk(ROOT).filter((f) => f.endsWith(".spec.ts") || f.includes("__tests__"));
let providers = 0,
  resolved = 0,
  unresolved = 0,
  notAClass = 0;
const findings = [];
const unresolvedTokens = new Map();

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const re = /\{\s*provide:\s*([A-Za-z_$][\w$]*)\s*,\s*useValue:/g;
  let m;
  while ((m = re.exec(text))) {
    providers++;
    const token = m[1];
    const after = text.slice(m.index + m[0].length);
    let keys = null;
    const trimmed = after.replace(/^\s*/, "");
    if (trimmed.startsWith("{")) {
      const sl = braceSlice(after, 0);
      if (sl) keys = topLevelKeys(sl.body);
    } else {
      const idm = /^([A-Za-z_$][\w$]*)/.exec(trimmed);
      if (idm) {
        const varName = idm[1];
        const vre = new RegExp(`(?:const|let|var)?\\s*${varName}\\s*=\\s*\\{`);
        const vm = vre.exec(text);
        if (vm) {
          const sl = braceSlice(text, vm.index + vm[0].length - 1);
          if (sl) keys = topLevelKeys(sl.body);
        }
      }
    }
    if (!keys || keys.length === 0) continue;

    const classFile = resolveImportIn(file, token, text);
    if (!classFile) {
      unresolved++;
      unresolvedTokens.set(token, (unresolvedTokens.get(token) ?? 0) + 1);
      continue;
    }
    const classText = readFileSync(classFile, "utf8");
    if (!declaresClass(classText, token)) {
      notAClass++;
      continue;
    }
    resolved++;
    const real = methodsWithInheritance(classFile, token);
    if (real.size === 0) continue;
    const bogus = keys.filter((k) => !real.has(k));
    if (bogus.length)
      findings.push({ file, token, bogus, classFile });
  }
}

// ── self-test ──────────────────────────────────────────────────────────────
// A census that cannot see the bug it was written for is a census that reports
// zero. Both halves are asserted before any number below is trusted.
const selfKeys = topLevelKeys(`
      list: jest.fn(),
      findOne: jest.fn(),
      nested: { a: 1 },
`);
const selfOk =
  selfKeys.join(",") === "list,findOne,nested" &&
  classMethodsIn("class X {\n  async listParties(a: string) {}\n  getParty(b: string) {}\n}").has("listParties") &&
  declaresClass("export class EmailService extends Base {", "EmailService") &&
  !declaresClass("export const APP_CONFIG = {", "APP_CONFIG");
process.stderr.write(`self-test keys=[${selfKeys}] ok=${selfOk}\n`);
if (UNRESOLVED_BASES.size)
  process.stderr.write(`unresolved base classes: ${[...UNRESOLVED_BASES].join("; ")}\n`);
if (!selfOk) {
  process.stderr.write("SELF-TEST FAILED — numbers below mean nothing\n");
  process.exit(2);
}

console.log(`providers with a literal double: ${providers}`);
console.log(`  resolved to a class file:      ${resolved}`);
console.log(`  token not resolvable:          ${unresolved}`);
console.log(`  token is not a class (skipped):${notAClass}`);
if (unresolvedTokens.size)
  console.log(
    `  unresolved tokens: ${[...unresolvedTokens.entries()].map(([t, n]) => `${t}(${n})`).join(", ")}`,
  );
console.log(`\nDOUBLES STUBBING A METHOD THE REAL CLASS DOES NOT HAVE: ${findings.length}`);
for (const f of findings) {
  console.log(`\n  ${f.file}`);
  console.log(`    ${f.token} — not on the real class: ${f.bogus.join(", ")}`);
}
