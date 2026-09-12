#!/usr/bin/env node
/**
 * A query field the API accepts and no code ever reads.
 *
 * `crm_list_deals` advertised `pipelineId` and `stageId` to agents; the input
 * type has neither, so both were accepted and silently dropped. A caller
 * filtering a list and receiving the unfiltered list back cannot tell.
 *
 * For each exported list/query Zod schema, this takes the field names and asks
 * whether the name appears anywhere in that module OUTSIDE the dto file. Zero
 * occurrences means nothing reads it.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";

const ROOT = process.argv[2] ?? "src/modules";

function walk(d, out = []) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    const st = statSync(p);
    if (st.isDirectory()) { if (e !== "node_modules") walk(p, out); }
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}
function braceSlice(t, from) {
  const s = t.indexOf("{", from);
  if (s < 0) return null;
  let d = 0;
  for (let i = s; i < t.length; i++) {
    if (t[i] === "{") d++;
    else if (t[i] === "}") { d--; if (!d) return t.slice(s + 1, i); }
  }
  return null;
}
const all = walk(ROOT);
const dtoFiles = all.filter((f) => f.includes("/dto/") && !f.includes(".spec."));
const findings = [];
let schemas = 0, fields = 0;

for (const dto of dtoFiles) {
  const text = readFileSync(dto, "utf8");
  /*
   * The TOP-LEVEL module, not the dto's grandparent.
   *
   * `dirname(dirname(dto))` looked right and was wrong: `kb/core/dto/` belongs
   * to a sub-module whose schemas are consumed by the SIBLING `kb/help-centre/`,
   * so scoping the search to `kb/core/` reported three fields as never read that
   * the article list reads on three consecutive lines. Three false positives,
   * all agreeing with what the census was hunting for.
   */
  const rel = dto.split("src/modules/")[1] ?? "";
  const top = rel.split("/")[0];
  const moduleDir = top ? join(ROOT.split("src/modules")[0] + "src/modules", top) : dirname(dirname(dto));
  const siblings = all.filter(
    (f) => f.startsWith(moduleDir + "/") && f !== dto && !f.includes(".spec.") && !f.includes("__tests__"),
  );
  const sibText = siblings.map((f) => readFileSync(f, "utf8")).join("\n");

  const re = /export const ((?:list|search)[A-Za-z]*(?:Query)?Schema|[A-Za-z]*QuerySchema)\s*=/g;
  let m;
  while ((m = re.exec(text))) {
    const body = braceSlice(text, m.index);
    if (!body) continue;
    schemas++;
    // depth-0 `name:` entries only
    let depth = 0, line = "";
    const names = [];
    for (const ch of body) {
      if ("{([".includes(ch)) depth++;
      else if ("})]".includes(ch)) depth--;
      if (ch === "\n") {
        const k = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(line);
        if (k && depth === 0) names.push(k[1]);
        line = "";
      } else line += ch;
    }
    for (const n of names) {
      fields++;
      if (["page", "limit", "offset", "cursor"].includes(n)) continue; // paging, read generically
      const used = new RegExp(`\\b${n}\\b`).test(sibText);
      if (!used) findings.push({ dto, schema: m[1], field: n });
    }
  }
}

// self-test: the extractor must find a known field, or a zero here means nothing
const probe = braceSlice("export const listXQuerySchema = z.object({\n  alpha: z.string(),\n  beta: z.number(),\n});", 0);
const ok = probe && /alpha/.test(probe) && /beta/.test(probe);
process.stderr.write(`self-test extractor ok=${ok}\n`);
if (!ok) { process.stderr.write("SELF-TEST FAILED\n"); process.exit(2); }

console.log(`dto files: ${dtoFiles.length}  schemas: ${schemas}  fields: ${fields}`);
console.log(`\nFIELDS ACCEPTED BUT NEVER READ IN THEIR MODULE: ${findings.length}`);
for (const f of findings) console.log(`  ${f.schema}.${f.field}\n      ${f.dto}`);
