import fs from "node:fs";
import path from "node:path";

const SEP = /[\\/]/.source;
const OWNED_BY_OTHERS = [
  "modules/notifications/",
  "modules/cron/",
  "modules/billing/",
  "modules/rbac/",
  "modules/access/",
  "modules/module-access/",
  "common/auth/",
  "common/rbac/",
];
const MINE_DONE = ["modules/build/", "modules/accounting/", "modules/invoices/", "modules/quotes/", "modules/crm/", "modules/chat/", "modules/mail/", "modules/search/"];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")) out.push(p);
  }
  return out;
}

function matchBrace(s, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function enclosingObject(s, idx) {
  let best = null;
  const re = /z\.object\(\s*\{/g;
  let m;
  while ((m = re.exec(s))) {
    const open = s.indexOf("{", m.index);
    if (open < 0) break;
    const close = matchBrace(s, open);
    if (open < idx && close > idx) best = { open, close };
    if (m.index > idx) break;
  }
  return best;
}

const FIELD_RE = /(\n[ \t]*)(page|pageSize|limit):\s*(z\.coerce\.number\(\)(?:\.[a-zA-Z$]+\([^()]*\))*)\s*,/g;

const changedFiles = [];
let converted = 0;
let skipped = 0;
const skipReasons = {};
function skip(reason) { skipped++; skipReasons[reason] = (skipReasons[reason] ?? 0) + 1; }

const posix = (p) => p.split(path.sep).join("/");

for (const file of walk("src")) {
  const rel = posix(path.relative("src", file));
  if (OWNED_BY_OTHERS.some((p) => rel.startsWith(p))) continue;
  if (MINE_DONE.some((p) => rel.startsWith(p))) continue;
  let src = fs.readFileSync(file, "utf8");
  if (!/(page|pageSize|limit):\s*z\.coerce\.number\(/.test(src)) continue;

  const edits = [];
  FIELD_RE.lastIndex = 0;
  let m;
  while ((m = FIELD_RE.exec(src))) {
    const [full, indent, name, chain] = m;
    const start = m.index;
    if (chain.includes(".optional()")) { skip("optional"); continue; }
    const defMatch = chain.match(/\.default\((\d+)\)/);
    if (!defMatch) { skip("no-default"); continue; }
    const def = Number(defMatch[1]);
    const rawMax = chain.match(/\.max\(([^)]*)\)/);
    if (rawMax && !/^\d[\d_]*$/.test(rawMax[1].trim())) { skip("non-literal-max"); continue; }
    const max = rawMax ? Number(rawMax[1].replace(/_/g, "")) : null;

    let replacement;
    if (name === "page") {
      if (def !== 1 || max !== null) { skip("page-nonstandard"); continue; }
      replacement = "pageNumberField";
    } else {
      if (name === "limit") {
        const obj = enclosingObject(src, start);
        if (!obj) { skip("limit-no-object"); continue; }
        const body = src.slice(obj.open, obj.close);
        if (!/\n\s*(page|pageSize|cursor|offset)\s*:/.test(body)) { skip("limit-not-a-list"); continue; }
      }
      replacement = max !== null ? `pageSizeField(${def}, ${max})` : `pageSizeField(${def})`;
    }
    edits.push({ start, end: start + full.length, text: `${indent}${name}: ${replacement},` });
  }

  if (!edits.length) continue;
  for (let i = edits.length - 1; i >= 0; i--) src = src.slice(0, edits[i].start) + edits[i].text + src.slice(edits[i].end);

  const needs = [];
  if (/\bpageNumberField\b/.test(src)) needs.push("pageNumberField");
  if (/\bpageSizeField\b/.test(src)) needs.push("pageSizeField");
  if (!/common\/pagination\/list-query\.schema/.test(src)) {
    let spec = posix(path.relative(path.dirname(file), path.join("src", "common", "pagination", "list-query.schema")));
    if (!spec.startsWith(".")) spec = "./" + spec;
    const importLine = `import { ${needs.join(", ")} } from "${spec}";\n`;
    const zodImport = /^import .*from "zod";\n/m.exec(src);
    src = zodImport
      ? src.slice(0, zodImport.index + zodImport[0].length) + importLine + src.slice(zodImport.index + zodImport[0].length)
      : importLine + src;
  }
  fs.writeFileSync(file, src);
  changedFiles.push(`${rel} (${edits.length})`);
  converted += edits.length;
}

console.log("files changed:", changedFiles.length, "| converted:", converted, "| skipped:", skipped);
console.log("skip reasons:", JSON.stringify(skipReasons));
fs.writeFileSync("../tmp-codemod-report.txt", changedFiles.join("\n"));
