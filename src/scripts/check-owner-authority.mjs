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
}

console.log(`production files scanned   ${scanned}`);
console.log(`owner shortcuts (reported) ${shortcuts.length}`);
for (const hit of shortcuts) {
  console.log(`  SKIP  ${hit.file}:${hit.line}  owner skips a permission check, not a gate`);
}
console.log("");

if (fabrications.length === 0 && gates.length === 0) {
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
console.error("");
console.error(
  `FAIL — ${fabrications.length} fabrication(s), ${gates.length} uncatalogued owner gate(s).`,
);
process.exit(1);
