// Which journalled migrations have no row in drizzle's bookkeeping table.
//
// Restored from a root dot-file that a `git add -A` swept away in a0f0cd23. It
// is the only tool in the repo that compares journal hashes against
// `drizzle.__drizzle_migrations`, and without it a migration applied by hand is
// invisibly "pending" — which is how 243 of 341 entries came to be unrecorded
// while their objects exist. The next `db:migrate` then wraps all 243 in one
// transaction, fails on the first "already exists", and rolls back everything.
//
//   node scripts/check-migrations-applied.mjs
//
// The hash is sha256 of the .sql file's contents, which is what drizzle-kit
// stores and what `apply-migration-file.mjs` now records.
import fs from "node:fs";
import crypto from "node:crypto";
import postgres from "postgres";
import * as dotenv from "dotenv";
dotenv.config();
const journal = JSON.parse(fs.readFileSync("migrations/meta/_journal.json", "utf8"));
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const rows = await sql`select hash from drizzle.__drizzle_migrations`;
const applied = new Set(rows.map(r => r.hash));
const missing = [];
for (const e of journal.entries) {
  const p = `migrations/${e.tag}.sql`;
  if (!fs.existsSync(p)) { missing.push([e.idx, e.tag, "FILE MISSING"]); continue; }
  const h = crypto.createHash("sha256").update(fs.readFileSync(p, "utf8")).digest("hex");
  if (!applied.has(h)) missing.push([e.idx, e.tag, "NOT APPLIED"]);
}
console.log("journal entries:", journal.entries.length, "applied hashes:", applied.size);
console.log("unapplied:", missing.length);
for (const m of missing) console.log(m.join("  "));
await sql.end();
