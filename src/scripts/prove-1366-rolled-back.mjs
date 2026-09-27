import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const TAG = "1366_user_sessions_mfa_satisfied_at";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("no DATABASE_URL");

const statements = readFileSync(join(process.cwd(), "migrations", `${TAG}.sql`), "utf8")
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const ROLLBACK_PROBE = "ROLLBACK_PROBE";

try {
  const [{ count: rowsBefore }] = await sql`SELECT count(*)::int AS count FROM user_sessions`;
  const [{ size: sizeBefore }] =
    await sql`SELECT pg_size_pretty(pg_total_relation_size('user_sessions')) AS size`;
  console.log(`\nuser_sessions before: ${rowsBefore} rows, ${sizeBefore}\n`);

  const [{ exists: columnBefore }] = await sql`
    SELECT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_name = 'user_sessions' AND column_name = 'mfa_satisfied_at') AS exists`;
  record("mfa_satisfied_at is absent before the migration runs", columnBefore === false);

  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL lock_timeout = '3s'");
      await tx.unsafe("SET LOCAL statement_timeout = '15s'");
      for (const statement of statements) await tx.unsafe(statement);

      const [{ dataType, isNullable, columnDefault }] = await tx`
        SELECT data_type AS "dataType", is_nullable AS "isNullable",
               column_default AS "columnDefault"
          FROM information_schema.columns
         WHERE table_name = 'user_sessions' AND column_name = 'mfa_satisfied_at'`;
      record(
        "adds mfa_satisfied_at as a nullable timestamp with no default",
        dataType === "timestamp without time zone" && isNullable === "YES" && columnDefault === null,
        `${dataType}, nullable=${isNullable}, default=${columnDefault}`,
      );

      const [{ count: stamped }] = await tx`
        SELECT count(*)::int AS count FROM user_sessions WHERE mfa_satisfied_at IS NOT NULL`;
      record(
        "leaves every existing session unstamped, so no session inherits a challenge it never passed",
        stamped === 0,
        `${stamped} of ${rowsBefore} stamped`,
      );

      await tx.unsafe("SAVEPOINT probe_write");
      const [existing] = await tx`SELECT id FROM user_sessions LIMIT 1`;
      if (existing) {
        await tx`UPDATE user_sessions SET mfa_satisfied_at = now() WHERE id = ${existing.id}`;
        const [{ stampedAt }] = await tx`
          SELECT mfa_satisfied_at AS "stampedAt" FROM user_sessions WHERE id = ${existing.id}`;
        record("accepts a timestamp stamp on a live session row", stampedAt instanceof Date);
        await tx.unsafe("ROLLBACK TO SAVEPOINT probe_write");
      } else {
        record("accepts a timestamp stamp on a live session row", false, "no session row to probe");
      }

      const [{ count: afterProbe }] = await tx`
        SELECT count(*)::int AS count FROM user_sessions WHERE mfa_satisfied_at IS NOT NULL`;
      record("the stamp probe leaves no residue after its savepoint rolls back", afterProbe === 0);

      const [{ count: rowsInTx }] = await tx`SELECT count(*)::int AS count FROM user_sessions`;
      record("adds and removes no rows", rowsInTx === rowsBefore, `${rowsInTx} vs ${rowsBefore}`);

      throw new Error(ROLLBACK_PROBE);
    });
  } catch (error) {
    if (error.message !== ROLLBACK_PROBE) throw error;
  }

  const [{ exists: columnAfter }] = await sql`
    SELECT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_name = 'user_sessions' AND column_name = 'mfa_satisfied_at') AS exists`;
  record("the column is gone again once the transaction rolls back", columnAfter === false);

  const [{ count: rowsAfter }] = await sql`SELECT count(*)::int AS count FROM user_sessions`;
  const [{ size: sizeAfter }] =
    await sql`SELECT pg_size_pretty(pg_total_relation_size('user_sessions')) AS size`;
  record("row count is unchanged", rowsAfter === rowsBefore, `${rowsAfter} vs ${rowsBefore}`);
  console.log(`\nuser_sessions after: ${rowsAfter} rows, ${sizeAfter}`);

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  await sql.end({ timeout: 5 });
}
