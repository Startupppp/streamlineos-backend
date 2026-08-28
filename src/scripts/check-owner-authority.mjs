// node src/scripts/check-owner-authority.mjs [--self-test] — 0 clean · 1 broken invariant · 2 broken scan

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(SCRIPT_DIR, "../..");
const SRC_DIR = join(BACKEND_ROOT, "src");

const SPEC_RE = /\.(spec|e2e-spec)\.ts$/;
const FABRICATION_RE = /isOrgOwner\s*:\s*true/;
const GATE_RE = /if\s*\(\s*!\s*[A-Za-z_$][\w$]*(?:\?)?\.isOrgOwner\s*\)/;
const REFUSAL_RE = /^\{?\s*throw\s+new\s+\w*(?:Forbidden|Unauthorized|BadRequest)\w*/;

const GATE_LOOKAHEAD_LINES = 4;

export const GATE_EXEMPT = new Map([
  ["src/common/rbac/owner-only-operations.ts", "the catalog and its one predicate"],
]);

export const UNENFORCED_EXEMPT = new Map([
  [
    "organization.legal-hold",
    "enforced by hr:legalhold:manage in modules/hr/governance/legal-holds, which S1 may not edit; raised as a cross-session request",
  ],
]);

const CATALOG_FILE = "src/common/rbac/owner-only-operations.ts";
const CATALOG_ID_RE = String.raw`^\s{2}"([a-z0-9.-]+)":\s*\{`;
const CATALOG_CALL_RE = String.raw`(?:assertOwnerOnly|holdsOwnerOnly)\s*\(\s*[^,]+,\s*"([a-z0-9.-]+)"`;

export function catalogIds(source) {
  return [...source.matchAll(new RegExp(CATALOG_ID_RE, "gm"))].map((m) => m[1]);
}

export function calledIds(source) {
  return [...source.matchAll(new RegExp(CATALOG_CALL_RE, "g"))].map((m) => m[1]);
}

function walkTs(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkTs(full));
      continue;
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

export function findFabrications(source) {
  const hits = [];
  source.split("\n").forEach((line, index) => {
    if (FABRICATION_RE.test(line)) hits.push({ line: index + 1, text: line.trim() });
  });
  return hits;
}

function blockAfterGate(lines, index) {
  const parts = [lines[index].replace(GATE_RE, "").trim()];
  for (let i = index + 1; i <= index + GATE_LOOKAHEAD_LINES && i < lines.length; i += 1) {
    parts.push(lines[i].trim());
  }
  return parts.join(" ").replace(/\/\/[^\n]*/g, "").trim();
}

export function findOwnerGates(source) {
  const lines = source.split("\n");
  const gates = [];
  const shortcuts = [];
  lines.forEach((line, index) => {
    if (!GATE_RE.test(line)) return;
    const hit = { line: index + 1, text: line.trim() };
    if (REFUSAL_RE.test(blockAfterGate(lines, index))) gates.push(hit);
    else shortcuts.push(hit);
  });
  return { gates, shortcuts };
}

if (process.argv.includes("--self-test")) {
  const failures = [];
  const fabricated = findFabrications(
    'const ctx = { userId: "u", isOrgOwner: true, sessionId: "system" };',
  );
  if (fabricated.length !== 1) failures.push("missed a fabricated isOrgOwner literal");

  const elevation = findOwnerGates('if (u.isOrgOwner) return "all";\nreturn resolved.get(key);');
  if (elevation.gates.length !== 0) failures.push("flagged an elevation as a gate");

  const gate = findOwnerGates(
    'if (!u.isOrgOwner) {\n  throw new ForbiddenException("Forbidden");\n}',
  );
  if (gate.gates.length !== 1) failures.push("missed a braced owner gate");

  const bare = findOwnerGates('if (!actor?.isOrgOwner)\n  throw new ForbiddenException("nope");');
  if (bare.gates.length !== 1) failures.push("missed an optional-chained unbraced owner gate");

  const ids = catalogIds(
    '  "organization.delete": {\n    summary: "x",\n  },\n  "organization.archive": {\n',
  );
  if (ids.length !== 2) failures.push("catalog id parser did not find both ids");
  const namedInCalls = calledIds(
    'assertOwnerOnly(u, "organization.delete");\nholdsOwnerOnly(actor, "finance.expense.grant-without-approval");',
  );
  if (namedInCalls.length !== 2) failures.push("call-site parser did not find both call sites");

  const shortcut = findOwnerGates(
    'if (!u.isOrgOwner) {\n  const perms = await resolve();\n  if (!perms.has("k")) {\n    throw new ForbiddenException("Forbidden");\n  }\n}',
  );
  if (shortcut.gates.length !== 0) failures.push("flagged an owner shortcut as a gate");
  if (shortcut.shortcuts.length !== 1) failures.push("did not record the shortcut");

  if (failures.length > 0) {
    console.error("SELF-TEST FAILED:");
    for (const f of failures) console.error(`  ${f}`);
    process.exit(2);
  }
  console.log("SELF-TEST OK — fabrication, gate, shortcut and elevation are told apart.");
  process.exit(0);
}

const files = walkTs(SRC_DIR);
if (files.length < 500) {
  console.error(
    `Walked only ${files.length} TypeScript files. That is a broken walker, not a small codebase.`,
  );
  process.exit(2);
}

const fabrications = [];
const gates = [];
const shortcuts = [];
const called = new Set();
let scanned = 0;

for (const file of files) {
  const rel = relative(BACKEND_ROOT, file).replace(/\\/g, "/");
  if (SPEC_RE.test(rel)) continue;
  scanned += 1;
  const source = readFileSync(file, "utf8");
  for (const hit of findFabrications(source)) fabrications.push({ ...hit, file: rel });
  if (GATE_EXEMPT.has(rel)) continue;
  const found = findOwnerGates(source);
  for (const hit of found.gates) gates.push({ ...hit, file: rel });
  for (const hit of found.shortcuts) shortcuts.push({ ...hit, file: rel });
  for (const id of calledIds(source)) called.add(id);
}

const declared = catalogIds(readFileSync(join(BACKEND_ROOT, CATALOG_FILE), "utf8"));
if (declared.length === 0) {
  console.error("Parsed 0 operations out of the catalog. That is a broken parser, not an empty catalog.");
  process.exit(2);
}
const unenforced = declared.filter(
  (id) => !called.has(id) && !UNENFORCED_EXEMPT.has(id),
);

console.log(`production files scanned   ${scanned}`);
console.log(`owner-only operations      ${declared.length} declared, ${called.size} enforced`);
for (const [id, why] of UNENFORCED_EXEMPT) {
  console.log(`  SKIP  ${id}  — ${why}`);
}
console.log(`owner shortcuts (reported) ${shortcuts.length}`);
for (const hit of shortcuts) {
  console.log(`  SKIP  ${hit.file}:${hit.line}  owner skips a permission check, not a gate`);
}
console.log("");

if (fabrications.length === 0 && gates.length === 0 && unenforced.length === 0) {
  console.log("OK — nothing fabricates ownership and every owner gate reads the catalog.");
  process.exit(0);
}

for (const hit of fabrications) {
  console.error(
    `  FABRICATED OWNER  ${hit.file}:${hit.line}  ${hit.text}\n    Use systemActor("<job id>", orgId) — a job's authority is its ceiling.`,
  );
}
for (const hit of gates) {
  console.error(
    `  UNCATALOGUED OWNER GATE  ${hit.file}:${hit.line}  ${hit.text}\n    Use assertOwnerOnly / holdsOwnerOnly and add the operation to common/rbac/owner-only-operations.ts.`,
  );
}
for (const id of unenforced) {
  console.error(
    `  CATALOGUED BUT UNENFORCED  ${id}\n    No assertOwnerOnly / holdsOwnerOnly call site names it. Gate it, or name it in UNENFORCED_EXEMPT with the reason.`,
  );
}
console.error("");
console.error(
  `FAIL — ${fabrications.length} fabrication(s), ${gates.length} uncatalogued owner gate(s), ${unenforced.length} unenforced operation(s).`,
);
process.exit(1);
