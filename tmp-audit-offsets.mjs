import fs from "node:fs";
import path from "node:path";

const OTHERS = ["modules/notifications/", "modules/cron/", "modules/billing/", "modules/rbac/", "modules/access/", "modules/module-access/", "common/auth/", "common/rbac/"];
const MINE = ["modules/build/", "modules/accounting/", "modules/invoices/", "modules/quotes/", "modules/crm/", "modules/chat/", "modules/mail/", "modules/search/"];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")) out.push(p);
  }
  return out;
}
const posix = (p) => p.split(path.sep).join("/");

/** Crude but effective method splitter: top-level `async name(` / `name(` at 2-space indent inside a class. */
function methods(src) {
  const out = [];
  const re = /\n {2}(?:private |public |protected )?(?:async )?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{/g;
  let m;
  const starts = [];
  while ((m = re.exec(src))) starts.push({ name: m[1], at: m.index });
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].at;
    const to = i + 1 < starts.length ? starts[i + 1].at : src.length;
    out.push({ name: starts[i].name, body: src.slice(from, to), from });
  }
  return out;
}

const findings = { sequential: [], parallel: [], windowed: [], noTotal: [], unknown: [] };

for (const file of walk("src")) {
  const rel = posix(path.relative("src", file));
  const src = fs.readFileSync(file, "utf8");
  if (!src.includes(".offset(")) continue;
  const owner = OTHERS.some((p) => rel.startsWith(p)) ? "OTHER" : MINE.some((p) => rel.startsWith(p)) ? "MINE" : "unclaimed";

  for (const meth of methods(src)) {
    if (!meth.body.includes(".offset(")) continue;
    const line = src.slice(0, meth.from + 1).split("\n").length;
    const tag = `${owner}  src/${rel}:${line}  ${meth.name}()`;
    const hasWindow = /count\(\*\)\s*OVER\s*\(\)|totalOverWindow/.test(meth.body);
    const hasCount = /\bcount\(\s*\)|count\(\*\)/.test(meth.body);
    const hasPromiseAll = /Promise\.all\(/.test(meth.body);

    if (!hasCount && !hasWindow) findings.noTotal.push(tag);
    else if (hasWindow) findings.windowed.push(tag);
    else if (hasPromiseAll) findings.parallel.push(tag);
    else if (hasCount) findings.sequential.push(tag);
    else findings.unknown.push(tag);
  }
}

for (const [k, v] of Object.entries(findings)) console.log(`${k}: ${v.length}`);
console.log("\n=== SEQUENTIAL (a page query, then a separate count) ===");
console.log(findings.sequential.join("\n"));
fs.writeFileSync("../tmp-offset-audit.txt", Object.entries(findings).map(([k, v]) => `## ${k} (${v.length})\n${v.join("\n")}`).join("\n\n"));
