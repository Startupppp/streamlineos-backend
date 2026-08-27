import fs from "node:fs";
import path from "node:path";

const OWNED_BY_OTHERS = ["modules/notifications/", "modules/cron/", "modules/billing/", "modules/rbac/", "modules/access/", "modules/module-access/", "common/auth/", "common/rbac/"];
const MINE_DONE = ["modules/build/", "modules/accounting/", "modules/invoices/", "modules/quotes/", "modules/crm/", "modules/chat/", "modules/mail/", "modules/search/"];
const CAP = 100;

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

let converted = 0;
const changed = [];
const overCap = [];

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
    const rawMax = chain.match(/\.max\(([^)]*)\)/);
    const maxLiteral = rawMax && /^\d[\d_]*$/.test(rawMax[1].trim());
    const max = maxLiteral ? Number(rawMax[1].replace(/_/g, "")) : null;
    const line = src.slice(0, m.index + 1).split("\n").length;

    if (rawMax && !maxLiteral) { overCap.push(`src/${rel}:${line}  ${name} — non-literal max ${rawMax[1].trim()}`); continue; }
    if (max !== null && max > CAP) { overCap.push(`src/${rel}:${line}  ${name} — ceiling ${max} exceeds the platform cap of ${CAP}`); continue; }

    const defMatch = chain.match(/\.default\((\d+)\)/);
    const isOptional = chain.includes(".optional()");
    let replacement = null;

    if (defMatch) {
      const def = Number(defMatch[1]);
      if (name === "page") replacement = def === 1 && max === null ? "pageNumberField" : null;
      else replacement = max !== null && max !== CAP ? `pageSizeField(${def}, ${max})` : `pageSizeField(${def})`;
    } else if (isOptional) {
      if (name === "page") replacement = "optionalPageNumberField()";
      else replacement = max !== null && max !== CAP ? `optionalPageSizeField(${max})` : "optionalPageSizeField()";
    }

    if (!replacement) continue;
    edits.push({ start: m.index, end: m.index + full.length, text: `${indent}${name}: ${replacement},` });
  }

  if (!edits.length) continue;
  for (let i = edits.length - 1; i >= 0; i--) src = src.slice(0, edits[i].start) + edits[i].text + src.slice(edits[i].end);

  const needed = ["pageNumberField", "pageSizeField", "optionalPageNumberField", "optionalPageSizeField"].filter((n) =>
    new RegExp(`(?<![A-Za-z])${n}(?![A-Za-z])`).test(src),
  );
  const existing = src.match(/^import \{([^}]*)\} from "([^"]*common\/pagination\/list-query\.schema)";$/m);
  if (existing) {
    src = src.replace(existing[0], `import { ${needed.join(", ")} } from "${existing[2]}";`);
  } else {
    let spec = posix(path.relative(path.dirname(file), path.join("src", "common", "pagination", "list-query.schema")));
    if (!spec.startsWith(".")) spec = "./" + spec;
    const importLine = `import { ${needed.join(", ")} } from "${spec}";`;
    const lines = src.split(/\r?\n/);
    const eol = src.includes("\r\n") ? "\r\n" : "\n";
    const zodIdx = lines.findIndex((l) => /^import .* from "zod";$/.test(l));
    lines.splice(zodIdx >= 0 ? zodIdx + 1 : 0, 0, importLine);
    src = lines.join(eol);
  }
  fs.writeFileSync(file, src);
  changed.push(`${rel} (${edits.length})`);
  converted += edits.length;
}

console.log("pass B — files:", changed.length, "| converted:", converted);
console.log("\nleft alone because the endpoint exceeds the platform cap (capability, not drift):");
console.log(overCap.map((l) => "  " + l).join("\n"));
