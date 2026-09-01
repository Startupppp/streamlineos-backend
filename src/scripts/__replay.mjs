import fs from "node:fs";
import postgres from "postgres";

const j = JSON.parse(fs.readFileSync("./.branch.tmp.json", "utf8"));
const url = `postgresql://${j.role}:${encodeURIComponent(j.password)}@${j.host}/coldboot?sslmode=require`;
const sql = postgres(url, {
  prepare: false,
  max: 1,
  onnotice: () => {},
  idle_timeout: 0,
  connect_timeout: 60,
});
const journal = JSON.parse(fs.readFileSync("migrations/meta/_journal.json", "utf8"));
const started = Date.now();
let applied = 0;
let skipped = 0;
const failures = [];

try {
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS drizzle`);
  await sql.unsafe(
    `CREATE TABLE IF NOT EXISTS drizzle.__replay (tag text primary key, at timestamptz default now())`,
  );
  const done = new Set((await sql`SELECT tag FROM drizzle.__replay`).map((r) => r.tag));

  for (const entry of journal.entries) {
    if (done.has(entry.tag)) {
      skipped++;
      continue;
    }
    const file = `migrations/${entry.tag}.sql`;
    if (!fs.existsSync(file)) {
      failures.push(`${entry.tag}: FILE MISSING`);
      continue;
    }
    const parts = fs
      .readFileSync(file, "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET statement_timeout = 0");
        await tx.unsafe("SET lock_timeout = '10s'");
        for (const stmt of parts) await tx.unsafe(stmt);
        await tx`INSERT INTO drizzle.__replay (tag) VALUES (${entry.tag}) ON CONFLICT DO NOTHING`;
      });
      applied++;
      if (applied % 25 === 0)
        console.log(
          `  ${applied} applied (${skipped} pre-done) at ${Math.round((Date.now() - started) / 1000)}s — last ${entry.tag}`,
        );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`${entry.tag}: ${msg.slice(0, 160)}`);
      console.log(`  FAIL ${entry.tag}: ${msg.slice(0, 120)}`);
    }
  }

  const [t] = await sql`SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'`;
  console.log(
    `\nRESULT: applied=${applied} skipped=${skipped} failures=${failures.length} tables=${t.n} in ${Math.round((Date.now() - started) / 1000)}s`,
  );
  if (failures.length) {
    console.log("FAILURES:");
    for (const f of failures.slice(0, 40)) console.log("  " + f);
  }
} finally {
  await sql.end();
}
