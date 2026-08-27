import fs from "node:fs";
import path from "node:path";

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

let fixed = 0;
for (const file of walk("src")) {
  const src = fs.readFileSync(file, "utf8");
  const lines = src.split(/\r?\n/);
  if (lines.length < 2) continue;
  const first = lines[0];
  if (!/^import \{ (pageNumberField|pageSizeField)[^}]*\} from ".*common\/pagination\/list-query\.schema";$/.test(first)) continue;
  const zodIdx = lines.findIndex((l) => /^import .* from "zod";$/.test(l));
  if (zodIdx <= 0) continue;
  lines.splice(0, 1);
  lines.splice(zodIdx, 0, first);
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  fs.writeFileSync(file, lines.join(eol));
  fixed++;
}
console.log("import order fixed in", fixed, "files");
