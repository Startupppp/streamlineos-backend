import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const TAG = "1366_user_sessions_mfa_satisfied_at";
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
const results = [];
const record = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

try {
  const [column] = await sql`
    SELECT data_type AS "dataType", is_nullable AS "isNullable",
           column_default AS "columnDefault"
      FROM information_schema.columns
     WHERE table_name = 'user_sessions' AND column_name = 'mfa_satisfied_at'`;
  record(
    "mfa_satisfied_at exists as a nullable timestamp with no default",
    column?.dataType === "timestamp without time zone"
      && column?.isNullable === "YES"
      && column?.columnDefault === null,
    column ? `${column.dataType}, nullable=${column.isNullable}, default=${column.columnDefault}` : "column absent",
  );

  const onDisk = createHash("sha256")
    .update(readFileSync(join(process.cwd(), "migrations", `${TAG}.sql`), "utf8"))
    .digest("hex");
  const [ledger] = await sql`
    SELECT hash, created_at AS "createdAt" FROM drizzle.__drizzle_migrations
     ORDER BY created_at DESC LIMIT 1`;
  record(
    "the ledger's newest row is this migration, hashed from the file on disk",
    ledger?.hash === onDisk,
    `ledger=${ledger?.hash?.slice(0, 12)}… disk=${onDisk.slice(0, 12)}…`,
  );

  const journal = JSON.parse(
    readFileSync(join(process.cwd(), "migrations", "meta", "_journal.json"), "utf8"),
  );
  const entry = journal.entries.find((e) => e.tag === TAG);
  record(
    "the ledger row's created_at matches the journal's when, so the tag and the row are the same migration",
    entry !== undefined && Number(ledger?.createdAt) === entry.when,
    `ledger=${ledger?.createdAt} journal=${entry?.when}`,
  );

  const [{ count: stamped }] = await sql`
    SELECT count(*)::int AS count FROM user_sessions WHERE mfa_satisfied_at IS NOT NULL`;
  const [{ count: total }] = await sql`SELECT count(*)::int AS count FROM user_sessions`;
  record(
    "no live session is stamped, so every session must pass a real challenge before it counts as MFA-satisfied",
    stamped === 0,
    `${stamped} of ${total} sessions stamped`,
  );

  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  await sql.end();
}
