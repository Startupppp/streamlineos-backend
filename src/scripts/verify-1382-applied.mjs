import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const TAG = "1382_notifications_membership_id_not_null";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("no DATABASE_URL");

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

try {
  const [col] = await sql`
    SELECT attnotnull AS "notNull"
      FROM pg_attribute
     WHERE attrelid = 'notifications'::regclass
       AND attname = 'membership_id'
       AND attnum > 0`;
  record("notifications.membership_id is NOT NULL in the catalog", col?.notNull === true);

  const [chk] = await sql`
    SELECT count(*)::int AS count
      FROM pg_constraint
     WHERE conname = 'chk_notifications_membership_id_not_null'
       AND conrelid = 'notifications'::regclass`;
  record(
    "the scaffolding CHECK constraint was dropped, leaving only the column constraint",
    chk.count === 0,
    `${chk.count} remaining`,
  );

  const journal = JSON.parse(readFileSync(join(process.cwd(), "migrations", "meta", "_journal.json"), "utf8"));
  const entry = journal.entries.find((e) => e.tag === TAG);
  record("the migration has a journal entry", Boolean(entry), entry ? `idx=${entry.idx} when=${entry.when}` : "");

  const diskHash = createHash("sha256")
    .update(readFileSync(join(process.cwd(), "migrations", `${TAG}.sql`)))
    .digest("hex");

  const ledger = await sql`
    SELECT hash, created_at AS "createdAt" FROM drizzle.__drizzle_migrations
     WHERE created_at = ${entry.when}`;
  record("the ledger holds exactly one row at the journal's when", ledger.length === 1, `${ledger.length} row(s)`);

  if (ledger.length === 1) {
    record(
      "the ledger hash matches the bytes on disk, so the applied file is the file in the tree",
      ledger[0].hash === diskHash,
      ledger[0].hash === diskHash ? "" : `ledger=${ledger[0].hash.slice(0, 12)} disk=${diskHash.slice(0, 12)}`,
    );
  }

  const [nulls] = await sql`
    SELECT count(*)::int AS count FROM notifications WHERE membership_id IS NULL`;
  record("no row carries a NULL membership_id", nulls.count === 0, `${nulls.count} NULL rows`);

  const [rows] = await sql`SELECT count(*)::int AS count FROM notifications`;
  console.log(`\nnotifications: ${rows.count} rows`);

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  await sql.end({ timeout: 5 });
}
