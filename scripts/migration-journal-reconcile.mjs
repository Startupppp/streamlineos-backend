import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Reconciles migrations/*.sql on disk against migrations/meta/_journal.json.
 *
 * Drizzle applies from the JOURNAL, not the directory. A .sql file with no journal entry never
 * runs, and `db:migrate` still reports success -- so an un-journalled file is invisible unless
 * something compares the two. Drizzle also skips by `when` TIMESTAMP, not by hash, so a new entry
 * whose timestamp is older than the last applied one is silently skipped too.
 */

const DIR = process.argv[2] ?? "migrations";

const onDisk = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => f.replace(/\.sql$/, ""))
  .sort();

const journal = JSON.parse(readFileSync(join(DIR, "meta", "_journal.json"), "utf8"));
const entries = journal.entries ?? [];
const journalled = new Set(entries.map((e) => e.tag));

const missing = onDisk.filter((tag) => !journalled.has(tag));
const orphaned = entries.filter((e) => !onDisk.includes(e.tag)).map((e) => e.tag);

let regressions = [];
for (let i = 1; i < entries.length; i += 1) {
  const prev = entries[i - 1];
  const cur = entries[i];
  if (cur.when <= prev.when) regressions.push(`${cur.tag} (when=${cur.when}) <= ${prev.tag} (when=${prev.when})`);
}

console.log(`sqlOnDisk=${onDisk.length} journalEntries=${entries.length}`);
console.log(`lastEntry=${entries.at(-1)?.tag} idx=${entries.at(-1)?.idx} when=${entries.at(-1)?.when}`);

console.log(`\nUN-JOURNALLED (${missing.length}) -- these will NEVER apply:`);
for (const tag of missing) console.log(`  ${tag}`);

console.log(`\nJOURNALLED BUT NO FILE (${orphaned.length}) -- db:migrate will fail on these:`);
for (const tag of orphaned) console.log(`  ${tag}`);

console.log(`\nTIMESTAMP REGRESSIONS (${regressions.length}) -- silently skipped:`);
for (const r of regressions) console.log(`  ${r}`);
