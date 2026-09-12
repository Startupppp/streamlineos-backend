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
 * TWO SECTIONS, because there are two ways to name a building.
 *
 * DIRECT is the original pass: `data.warehouseId`, `data.locationId` and the
 * two transfer ends. IMPLIED follows a DOCUMENT id to the warehouse it implies
 * — `data.soId` is not a location, but the sales order it names sits in one,
 * and a return anchored to that order is attributed through it. The first pass
 * could not see that shape and so missed both return `create`s, which let a
 * scoped operator raise a DRAFT against another warehouse's order, shipment or
 * receipt: inert, since a DRAFT moves no stock and every later step is gated,
 * but still a write into a building they hold nothing in, and one that then
 * measured that building's despatches through the returnable-quantity check.
 *
 * The IMPLIED map is DERIVED, never hand-listed. Every `*_id` column in the
 * schema whose foreign key points at an inventory table carrying `warehouse_id`
 * or `location_id` becomes a field to watch, so a new document type joins the
 * census by existing rather than by somebody remembering to add it. It is also
 * what keeps the list short: `productVariantId` and `lotId` are FKs too and
 * neither target carries a building, so neither appears.
 *
 * A LEAD LIST, not a bug count, and IMPLIED leans further that way than DIRECT.
 * Several hits are `*InTx` helpers whose public caller already gates, which this
 * cannot follow; and an implied hit is only a defect if the document is actually
 * the aggregate's attribution — a vendor return is attributed through its GRN
 * and deliberately NOT through its PO, so `poId` reads here as a lead and is
 * answered in the code as a decision. Read each one.
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

/** Named on the body itself. `inv_warehouses` has no `warehouse_id`, so these cannot be derived. */
const DIRECT = ["warehouseId", "locationId", "toLocationId", "fromLocationId"];

/**
 * Which inventory tables carry an attribution, and under which column.
 *
 * `warehouse_id` wins where a table has both: it is the coarser of the two and
 * the one a scope is expressed in.
 */
const attribution = {};
const tableOf = {};
for (const file of walk("src/db/schema/inventory")) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/export const (\w+) = pgTable\("(\w+)",\s*\{([\s\S]*?)\n\}/g)) {
    tableOf[m[1]] = m[2];
    if (/^\s*warehouseId:/m.test(m[3])) attribution[m[1]] = "warehouse_id";
    else if (/^\s*locationId:/m.test(m[3])) attribution[m[1]] = "location_id";
  }
}

/** Body field -> the attributed table(s) its foreign key points at. */
const implies = {};
for (const file of walk("src/db/schema")) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/^\s*(\w+): (?:integer|bigint)\("\w+"[^\n]*?\.references\(\(\) => (\w+)\.id/gm))
    if (attribution[m[2]] && !DIRECT.includes(m[1])) (implies[m[1]] ??= new Set()).add(m[2]);
}

const reads = (inner, fields) =>
  fields.filter((f) => new RegExp(`\\b(input|body|data|dto)\\.${f}\\b`).test(inner));

const direct = [], implied = [];
for(const file of walk(ROOT)){
  const src=readFileSync(file,"utf8");
  if(!/warehouseScope|WarehouseScopeService/.test(src)) continue;
  for(const m of methods(src)){
    if(m.name.startsWith("_")) continue;
    const inner=m.body.split("\n").slice(1).join("\n");
    // Already asserts it. The second arm catches a gate the method delegates to
    // a named private of its own (`assertSourceInScope`, `assertReturnVisible`),
    // which is how the two return creates answer this census.
    if(/assertWarehouseVisible|assertLocationVisible|assertLocationsInScope|warehouseScope\./.test(inner)) continue;
    if(/this\.assert\w*(Scope|Visible)\b/.test(inner)) continue;
    const at = `${file.replace("src/modules/","")}:${m.line}  ${m.name}()`;
    if (reads(inner, DIRECT).length) { direct.push(at); continue; }
    const via = reads(inner, Object.keys(implies));
    if (via.length)
      implied.push(`${at}   via ${via.map((f) => `${f} -> ${[...implies[f]].map((t) => `${tableOf[t]}.${attribution[t]}`).join("/")}`).join(", ")}`);
  }
}

console.log(`# DIRECT — a warehouse or location named on the body, with no visibility assert: ${direct.length}`);
console.log("# A LEAD LIST — the assert may live in a helper this cannot follow.\n");
for(const h of direct) console.log(`  ${h}`);
console.log(`\n# IMPLIED — a DOCUMENT named on the body whose own row sits in a warehouse: ${implied.length}`);
console.log(`# Derived from ${Object.keys(implies).length} foreign keys into attributed tables.`);
console.log("# Weaker leads: only a defect where that document is the aggregate's attribution.\n");
for(const h of implied) console.log(`  ${h}`);
