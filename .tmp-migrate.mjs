import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { readFileSync } from "node:fs";

const uri = readFileSync(process.argv[2], "utf8").trim();
const sql = postgres(uri, { max: 1, prepare: false, ssl: "require", onnotice: () => {} });
const db = drizzle(sql);
try {
  await migrate(db, { migrationsFolder: "./migrations" });
  process.stdout.write("MIGRATE OK\n");
} catch (err) {
  process.stdout.write(`MIGRATE FAILED\n`);
  let c = err;
  let i = 0;
  while (c && i < 6) {
    process.stdout.write(
      `[${i}] code=${c.code} severity=${c.severity} routine=${c.routine} msg=${String(c.message).slice(0, 400)}\n`,
    );
    c = c.cause;
    i++;
  }
  const e = err ?? {};
  if (e?.code) process.stdout.write(`code: ${e.code}\n`);
  if (e?.detail) process.stdout.write(`detail: ${e.detail}\n`);
  if (e?.hint) process.stdout.write(`hint: ${e.hint}\n`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
