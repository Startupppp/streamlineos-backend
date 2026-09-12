/**
 * Lead generator: an aggregate that narrows, beside a detail that does not.
 *
 * DELIBERATELY NOT A `check:*` GATE, and it must not become one. Its output is a
 * CANDIDATE COUNT, not a bug count — it cannot see a scope enforced in the
 * controller, in a guard, or by a caller that has already narrowed. Wiring it to
 * CI would either be ignored or answered by suppressing entries, and a
 * suppression list is how a census stops being read.
 *
 * WHAT IT LOOKS FOR. In a service that resolves `warehouseScope` somewhere,
 * every public method that reads the database, takes an id, and does not resolve
 * a scope. The `!!` rows are the sharp ones: a method whose signature contains
 * no caller identity at all CANNOT scope, whatever the controller intends,
 * because it was never told who is asking.
 *
 * WHY IT EXISTS. Two instances turned up within an hour of each other —
 * `LaborService.recentFor` behind a scoped labour board, and
 * `asnDetail` behind a scoped ASN list — and in both the controller had
 * `@CurrentUser()` in hand and passed only `orgId`. Two is a coincidence; this
 * census was written to find out which it was. It is not a coincidence.
 *
 * TWO WAYS AN EARLIER DRAFT OF THIS SCRIPT LIED, both worth knowing:
 *
 *  1. It reported ZERO. The parameter test was `\bId:\s*number`, and `\b`
 *     before `Id` cannot match inside `asnId` — the word boundary is at the
 *     start of `asnId`, not before its `Id`. Every signature failed it. A census
 *     that finds nothing is a census to distrust before it is a codebase to
 *     trust, which is why the self-test line below prints what it examined.
 *  2. Parameters were read with `[^)]*`, which stops at the first `)` and
 *     returns an empty list for every multi-line signature — the common style
 *     here. They are now read by balancing parentheses.
 *
 * Usage: `node src/scripts/census-unscoped-detail-methods.mjs [dir]`
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.argv[2] ?? "src/modules/inventory";

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (e.endsWith(".ts") && !e.includes(".spec.")) out.push(full);
  }
  return out;
}

/**
 * Class methods with their parameter list and body.
 *
 * Signatures here are routinely multi-line, so params are read by balancing
 * parentheses from the opening one rather than with `[^)]*` — which stopped at
 * the first `)` and returned an empty list for every wrapped signature.
 */
function methodsOf(source) {
  const lines = source.split("\n");
  const out = [];
  const head = /^  (private |public |protected )?(async )?([A-Za-z][A-Za-z0-9_]*)\(/;
  for (let i = 0; i < lines.length; i++) {
    const m = head.exec(lines[i]);
    if (m === null) continue;
    const name = m[3];
    if (["constructor", "if", "for", "while", "switch", "catch", "return"].includes(name)) continue;
    let depth = 0, params = "", j = i, k = lines[i].indexOf("(");
    outer: for (; j < lines.length; j++) {
      const line = lines[j];
      for (; k < line.length; k++) {
        const ch = line[k];
        if (ch === "(") depth++;
        else if (ch === ")") { depth--; if (depth === 0) break outer; }
        else if (depth > 0) params += ch;
      }
      params += " ";
      k = 0;
    }
    let end = i;
    for (let n = j; n < lines.length; n++) if (lines[n] === "  }") { end = n; break; }
    out.push({ name, params, body: lines.slice(i, end + 1).join("\n"), isPrivate: m[1] === "private ", line: i + 1 });
  }
  return out;
}

const ID_PARAM = /[A-Za-z]*[Ii]d\??:\s*(number|string)/;

const findings = [];
let stats = { files: 0, withScope: 0, methods: 0, dbMethods: 0, idMethods: 0 };
for (const file of walk(ROOT)) {
  stats.files++;
  const src = readFileSync(file, "utf8");
  if (!/warehouseScope|WarehouseScopeService/.test(src)) continue;
  stats.withScope++;
  const methods = methodsOf(src);
  stats.methods += methods.length;
  stats.dbMethods += methods.filter((m) => /this\.db\b/.test(m.body)).length;
  stats.idMethods += methods.filter((m) => ID_PARAM.test(m.params)).length;

  const scoped = methods.filter((x) => /warehouseScope\./.test(x.body));
  if (scoped.length === 0) continue;
  for (const m of methods) {
    if (m.isPrivate) continue;
    if (/warehouseScope\./.test(m.body)) continue;
    if (!/this\.db\b/.test(m.body)) continue;
    if (!ID_PARAM.test(m.params)) continue;
    const takesUser = /userId|user:\s*CurrentUserContext|CurrentUserContext/.test(m.params);
    findings.push({ file, method: m.name, line: m.line, takesUser, siblings: scoped.map((s) => s.name) });
  }
}

findings.sort((a, b) => Number(a.takesUser) - Number(b.takesUser));
console.log(`# candidates: ${findings.length}  (a LEAD LIST, not a bug count)\n`);
for (const f of findings) {
  console.log(`${f.takesUser ? "  " : "!!"} ${f.file.replace("src/modules/inventory/", "")}:${f.line}  ${f.method}()${f.takesUser ? "" : "   <- receives no caller id, so it CANNOT scope"}`);
  console.log(`      scoped siblings in the same file: ${f.siblings.slice(0, 5).join(", ")}`);
}
console.error(`\nSELF-TEST ${JSON.stringify(stats)}`);
