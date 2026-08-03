// Run a read-only SQL query against a target Postgres/Neon database and print rows.
// Usage:
//   node scripts/db-query.mjs "<sql>" [--url <CONNECTION_URL>]
// Falls back to DATABASE_URL (loaded from backend/.env) when --url is omitted.
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config();

const args = process.argv.slice(2);
let url = process.env.DATABASE_URL;
const queryParts = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--url") url = args[++i];
  else queryParts.push(args[i]);
}
const query = queryParts.join(" ");

if (!url) {
  console.error("No target DB: pass --url <CONNECTION_URL> or set DATABASE_URL.");
  process.exit(1);
}
if (!query) {
  console.error('Usage: db-query.mjs "<sql>" [--url <URL>]');
  process.exit(1);
}

const sql = postgres(url, { max: 1 });

try {
  const rows = await sql.unsafe(query);
  console.log(JSON.stringify(rows, null, 2));
} catch (err) {
  console.error("QUERY FAILED:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await sql.end();
}
