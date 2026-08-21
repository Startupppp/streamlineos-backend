import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import postgres from "postgres";

const ROOT = path.resolve(import.meta.dirname, "../..");
const MIGRATIONS = path.join(ROOT, "migrations");
const JOURNAL = path.join(MIGRATIONS, "meta", "_journal.json");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const tagArg = args.find((a) => a.startsWith("--tag="))?.slice("--tag=".length);

const url = process.env.DATABASE_URL ?? process.env.DB;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const sql = postgres(url, { prepare: false, max: 1, ssl: "require", onnotice: () => {} });

function statementsOf(text) {
  if (text.includes("--> statement-breakpoint"))
    return text.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
  return [text];
}

async function applyOne(entry, when) {
  const file = path.join(MIGRATIONS, `${entry.tag}.sql`);
  if (!fs.existsSync(file)) throw new Error(`missing file ${entry.tag}.sql`);
  const text = fs.readFileSync(file, "utf8");
  const hash = crypto.createHash("sha256").update(text).digest("hex");
  const already = await sql`select 1 from drizzle.__drizzle_migrations where hash = ${hash} limit 1`;
  if (already.length) {
    console.log(`  = ${entry.tag} already recorded, skipping`);
    return "skipped";
  }
  const concurrent = /CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(text);
  if (dryRun) {
    console.log(`  ~ ${entry.tag} would apply (${statementsOf(text).length} stmts${concurrent ? ", CONCURRENTLY -> no txn" : ""})`);
    return "dry";
  }
  if (concurrent) {
    for (const stmt of statementsOf(text)) await sql.unsafe(stmt);
    await sql`insert into drizzle.__drizzle_migrations (hash, created_at) values (${hash}, ${when})`;
  } else {
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`insert into drizzle.__drizzle_migrations (hash, created_at) values (${hash}, ${when})`;
    });
  }
  console.log(`  + ${entry.tag} applied`);
  return "applied";
}

try {
  const journal = JSON.parse(fs.readFileSync(JOURNAL, "utf8"));
  const [{ mx }] = await sql`select coalesce(max(created_at), 0) mx from drizzle.__drizzle_migrations`;
  const watermark = Number(mx);
  let queue;
  if (tagArg) {
    const entry = journal.entries.find((e) => e.tag === tagArg) ?? { tag: tagArg };
    queue = [[entry, entry.when ?? watermark + 1]];
    console.log(`Running explicit tag: ${tagArg}`);
  } else {
    queue = journal.entries.filter((e) => e.when > watermark).map((e) => [e, e.when]);
    console.log(`watermark=${watermark} | pending=${queue.length}`);
  }
  for (const [entry, when] of queue) {
    try {
      await applyOne(entry, when);
    } catch (err) {
      console.error(`\n  ! ${entry.tag} FAILED — rolled back`);
      console.error(`    ${err.message}`);
      if (err.position) console.error(`    at position ${err.position}`);
      if (err.detail) console.error(`    detail: ${err.detail}`);
      if (err.hint) console.error(`    hint: ${err.hint}`);
      process.exitCode = 1;
      break;
    }
  }
} finally {
  await sql.end();
}
