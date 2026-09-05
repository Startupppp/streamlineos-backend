import postgres from "postgres";
import { readFileSync } from "node:fs";

const uri = readFileSync(process.argv[2], "utf8").trim();
const sql = postgres(uri, { max: 1, prepare: false, ssl: "require", onnotice: () => {} });
try {
  const db = await sql`SELECT current_database() AS d`;
  const tables =
    await sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')`;
  let head = "n/a";
  try {
    const h =
      await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
    head = String(h[0].n);
  } catch {
    head = "no drizzle migrations table";
  }
  let orgs = "n/a";
  try {
    const o = await sql`SELECT count(*)::int AS n FROM organizations`;
    orgs = String(o[0].n);
  } catch {
    orgs = "no organizations table";
  }
  process.stdout.write(
    `database=${db[0].d} tables=${tables[0].n} migrations_applied=${head} organizations=${orgs}\n`,
  );
} finally {
  await sql.end();
}
