import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const CORE = "src/modules/build/core";
const DRY = process.argv.includes("--dry");

function collect(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}
const byName = new Map();
for (const f of collect(CORE)) {
  const name = f.split(sep).pop();
  if (!byName.has(name)) byName.set(name, []);
  byName.get(name).push(f.split(sep).join("/"));
}

const TARGETS = [
  "src/scripts/assertion-ceiling-ledger.json",
  "src/scripts/check-type-assertions.mjs",
  "src/scripts/ticket-write-module-ratchet.json",
  "src/scripts/check-request-txn-outbound.mjs",
  "src/scripts/check-dead-code.mjs",
  "src/scripts/baselines/db-call-count-classification.json",
  "src/scripts/baselines/unbounded-reads-baseline.json",
  "src/scripts/baselines/unbounded-reads-classification.json",
  "test/security/appsec/injection-surfaces.spec.ts",
  "test/security/bola/live/own-tenant-500-routes.json",
];

let total = 0;
for (const target of TARGETS) {
  const source = readFileSync(target, "utf8");
  const found = new Set();
  for (const m of source.matchAll(/(?:src\/)?modules\/build\/core\/([A-Za-z0-9_.-]+\.ts)/g)) {
    found.add(m[0]);
  }
  for (const m of source.matchAll(/(?<=")\/build\/core\/[A-Za-z0-9_.-]+\.ts/g)) {
    found.add(m[0]);
  }
  let out = source;
  const changes = [];
  for (const hit of found) {
    const abs = hit.startsWith("/") ? `src/modules${hit}` : hit.startsWith("src/") ? hit : `src/${hit}`;
    if (existsSync(abs)) continue;
    const base = hit.split("/").pop();
    const candidates = byName.get(base) ?? [];
    if (candidates.length !== 1) {
      console.log(`  ?? ${target}: ${hit} -> ${candidates.length} candidate(s)`);
      continue;
    }
    const resolved = hit.startsWith("/")
      ? candidates[0].slice("src/modules".length)
      : hit.startsWith("src/")
        ? candidates[0]
        : candidates[0].slice("src/".length);
    out = out.split(hit).join(resolved);
    changes.push(`${hit} -> ${resolved}`);
  }
  if (changes.length) {
    console.log(target);
    for (const c of changes) console.log(`    ${c}`);
    total += changes.length;
    if (!DRY) writeFileSync(target, out);
  }
}
console.log(`${DRY ? "would rewrite" : "rewrote"} ${total} stranded Build path key(s)`);
