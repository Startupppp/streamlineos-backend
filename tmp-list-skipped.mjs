import fs from "node:fs";
import path from "node:path";

const OWNED_BY_OTHERS = ["modules/notifications/", "modules/cron/", "modules/billing/", "modules/rbac/", "modules/access/", "modules/module-access/", "common/auth/", "common/rbac/"];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")) out.push(p);
  }
  return out;
}
const posix = (p) => p.split(path.sep).join("/");
const FIELD_RE = /(\n[ \t]*)(page|pageSize|limit):\s*(z\.coerce\.number\(\)(?:\.[a-zA-Z$]+\([^()]*\))*)\s*,/g;

const rows = [];
for (const file of walk("src")) {
  const rel = posix(path.relative("src", file));
  const src = fs.readFileSync(file, "utf8");
  FIELD_RE.lastIndex = 0;
  let m;
  while ((m = FIELD_RE.exec(src))) {
    const line = src.slice(0, m.index + 1).split("\n").length;
    const mine = OWNED_BY_OTHERS.some((p) => rel.startsWith(p)) ? "OTHER-SESSION" : "unclaimed";
    rows.push(`${mine}  src/${rel}:${line}  ${m[2]}: ${m[3]}`);
  }
}
console.log("remaining hand-rolled fields:", rows.length);
console.log(rows.join("\n"));
