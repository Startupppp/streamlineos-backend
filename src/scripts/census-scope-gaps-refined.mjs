/**
 * Refines `census-unscoped-detail-methods.mjs` by following ONE level of
 * same-file private helpers.
 *
 * DELIBERATELY NOT A `check:*` GATE either, for the same reason as its parent:
 * the output is a LEAD LIST. It still cannot see a gate in a controller, in a
 * caller that has already narrowed, or two helpers deep.
 *
 * The census flags a method that does not itself resolve `warehouseScope`. That
 * is the right lead, and it is wrong wherever the gate lives in a private helper
 * -- `inv-cycle-counts.service.ts` funnels all five mutations through
 * `requireCount`, which resolves the scope, and the census reports all five.
 * Reading those five by hand and finding them already correct is how this got
 * written: the manual pass has to start from a list that is not mostly noise.
 * 114 candidates became 80, and the 43 mutations are the half worth reading
 * first -- a read discloses another building, a mutation changes it.
 *
 * THE CHEAP CHECK BEFORE TRUSTING ANY RUN: point it at a defect you have
 * already read with your own eyes and confirm it comes back. Its parent was
 * wrong four times and every time in the direction its author wanted.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.argv[2] ?? "src/modules/inventory";
const SCOPE = /warehouseScope|warehousePredicate|resolveWarehouses|assertWarehouse|locationScope|stockScope|scopeFor/;

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (e.endsWith(".ts") && !e.includes(".spec.")) out.push(full);
  }
  return out;
}

function methods(src) {
  const lines = src.split("\n");
  const out = [];
  const head = /^  (private |public |protected )?(async )?([A-Za-z][A-Za-z0-9_]*)\(/;
  for (let i = 0; i < lines.length; i++) {
    const m = head.exec(lines[i]);
    if (!m) continue;
    const name = m[3];
    if (["constructor","if","for","while","switch","catch","return"].includes(name)) continue;
    let end = i;
    for (let n = i + 1; n < lines.length; n++) if (lines[n] === "  }") { end = n; break; }
    out.push({ name, isPrivate: m[1] === "private ", body: lines.slice(i, end + 1).join("\n"), line: i + 1 });
  }
  return out;
}

const rows = [];
for (const file of walk(ROOT)) {
  const src = readFileSync(file, "utf8");
  if (!SCOPE.test(src)) continue;            // file has no scope machinery at all
  const ms = methods(src);
  const scopedHelpers = new Set(ms.filter((m) => SCOPE.test(m.body)).map((m) => m.name));
  for (const m of ms) {
    if (m.isPrivate) continue;
    if (!/this\.db|\.query\.|db\.execute|tx\./.test(m.body)) continue;   // reads nothing
    if (SCOPE.test(m.body)) continue;                                    // scopes itself
    // one level: does it call a same-file method that scopes?
    const viaHelper = [...scopedHelpers].find((h) => new RegExp(`this\\.${h}\\s*\\(`).test(m.body));
    if (viaHelper) continue;
    const takesUser = /userId|actorUserId|user:|currentUser/.test(m.body.split("\n")[0]);
    rows.push({ file: file.replace(ROOT + "/", ""), line: m.line, name: m.name, takesUser });
  }
}

const mut = /^(create|update|approve|post|cancel|close|reopen|ship|dispatch|complete|reserve|release|allocate|execute|reverse|assemble|disassemble|scan|dismiss|set|book|start|review|exit|accept|ingest|delete|remove|add|apply|void|receive|pick|pack|put|assign|link|merge|split|confirm|reject|resolve)/i;
const mutations = rows.filter((r) => mut.test(r.name));
const reads = rows.filter((r) => !mut.test(r.name));

console.log(`AFTER FOLLOWING ONE LEVEL OF PRIVATE HELPERS: ${rows.length} candidates (census said 114)\n`);
console.log(`## MUTATIONS (${mutations.length}) — acting on another warehouse's record\n`);
for (const r of mutations) console.log(`${r.takesUser ? "   " : "!! "}${r.file}:${r.line}  ${r.name}()`);
console.log(`\n## READS (${reads.length})\n`);
for (const r of reads) console.log(`${r.takesUser ? "   " : "!! "}${r.file}:${r.line}  ${r.name}()`);
