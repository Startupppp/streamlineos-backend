/**
 * Lead generator: a warehouse or location taken from the request BODY and never
 * asserted visible.
 *
 * The sibling census (`census-unscoped-detail-methods.mjs`) looks for a method
 * that receives no caller id, so it structurally CANNOT see this class: these
 * methods all have a `userId` and simply never use it on the location the
 * client handed them. The counts agent found four of its fourteen real defects
 * in exactly that shape and suggested this pass; the first thing it found was
 * `createTransfer`, which drafted a move out of any warehouse in the
 * organisation because the two inserts behind it never touch the stock engine.
 *
 * The engine's `assertLocationsInScope` is not a backstop for these. It runs
 * when movements POST, which is later, and only when there are movements — a
 * draft, a header, a zero-variance post or a reservation reaches none of it.
 *
 * A LEAD LIST, not a bug count. Several hits are `*InTx` helpers whose public
 * caller already gates, which this cannot follow. Read each one.
 *
 * Usage: `node src/scripts/census-unasserted-body-locations.mjs [dir]`
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const ROOT = process.argv[2] ?? "src/modules/inventory";
function walk(dir){const o=[];for(const e of readdirSync(dir)){const f=join(dir,e);if(statSync(f).isDirectory())o.push(...walk(f));else if(f.endsWith(".ts")&&!f.includes(".spec."))o.push(f);}return o;}
function methods(src){
  const lines=src.split("\n"); const heads=[];
  for(let i=0;i<lines.length;i++)
    if(/^  (private |public |protected )?(async )?[A-Za-z][A-Za-z0-9_]*\(/.test(lines[i])) heads.push(i);
  return heads.map((s,n)=>({line:s+1,name:(/([A-Za-z][A-Za-z0-9_]*)\s*\(/.exec(lines[s])??[,"?"])[1],
    body:lines.slice(s,heads[n+1]??lines.length).join("\n"),head:lines[s]}));
}
const hits=[];
for(const file of walk(ROOT)){
  const src=readFileSync(file,"utf8");
  if(!/warehouseScope|WarehouseScopeService/.test(src)) continue;
  for(const m of methods(src)){
    if(m.name.startsWith("_")) continue;
    const inner=m.body.split("\n").slice(1).join("\n");
    // Reads a warehouse or location out of a body/input object it was handed.
    if(!/\b(input|body|data|dto)\.(warehouseId|locationId|toLocationId|fromLocationId)\b/.test(inner)) continue;
    // Already asserts it.
    if(/assertWarehouseVisible|assertLocationVisible|assertLocationsInScope|warehouseScope\./.test(inner)) continue;
    hits.push({file,...m});
  }
}
console.log(`# create/update methods taking a warehouse or location in the BODY with no visibility assert: ${hits.length}`);
console.log("# A LEAD LIST — the assert may live in a helper this cannot follow.\n");
for(const h of hits) console.log(`  ${h.file.replace("src/modules/","")}:${h.line}  ${h.name}()`);
