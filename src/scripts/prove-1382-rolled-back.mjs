import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const TAG = "1382_notifications_membership_id_not_null";
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
  const [{ count: rowsBefore }] = await sql`SELECT count(*)::int AS count FROM notifications`;
  const [{ size: sizeBefore }] =
    await sql`SELECT pg_size_pretty(pg_total_relation_size('notifications')) AS size`;
  console.log(`\nnotifications before: ${rowsBefore} rows, ${sizeBefore}\n`);

  const [{ isNullableBefore }] = await sql`
    SELECT is_nullable AS "isNullableBefore"
      FROM information_schema.columns
     WHERE table_name = 'notifications' AND column_name = 'membership_id'`;
  record(
    "membership_id is nullable before the migration runs",
    isNullableBefore === "YES",
    `is_nullable=${isNullableBefore}`,
  );

  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL lock_timeout = '5s'");
      await tx.unsafe("SET LOCAL statement_timeout = '30s'");
      for (const statement of statements) await tx.unsafe(statement);

      const [{ isNullableAfter }] = await tx`
        SELECT is_nullable AS "isNullableAfter"
          FROM information_schema.columns
         WHERE table_name = 'notifications' AND column_name = 'membership_id'`;
      record(
        "membership_id becomes NOT NULL after the migration",
        isNullableAfter === "NO",
        `is_nullable=${isNullableAfter}`,
      );

      const [{ nullCount }] = await tx`
        SELECT count(*)::int AS "nullCount" FROM notifications WHERE membership_id IS NULL`;
      record(
        "no existing row has a NULL membership_id",
        nullCount === 0,
        `${nullCount} NULL rows`,
      );

      const [{ count: rowsInTx }] = await tx`SELECT count(*)::int AS count FROM notifications`;
      record(
        "row count is unchanged inside the transaction",
        rowsInTx === rowsBefore,
        `${rowsInTx} vs ${rowsBefore}`,
      );

      const [existing] = await tx`
        SELECT org_id AS "orgId", membership_id AS "membershipId"
          FROM notifications
         LIMIT 1`;
      if (!existing) throw new Error("no notification row to borrow a real org_id from");

      await tx.unsafe("SAVEPOINT null_insert_probe");
      let nullInsertCode = null;
      try {
        await tx`
          INSERT INTO notifications (org_id, membership_id, title, message)
          VALUES (${existing.orgId}, NULL, 'probe', 'probe')`;
      } catch (error) {
        nullInsertCode = error.code ?? "none";
      }
      record(
        "an insert with NULL membership_id is refused with not_null_violation, not some other error",
        nullInsertCode === "23502",
        `sqlstate=${nullInsertCode ?? "insert succeeded"}`,
      );
      await tx.unsafe("ROLLBACK TO SAVEPOINT null_insert_probe");

      await tx.unsafe("SAVEPOINT real_insert_probe");
      let realInsertOk = false;
      let realInsertCode = null;
      try {
        await tx`
          INSERT INTO notifications (org_id, membership_id, title, message)
          VALUES (${existing.orgId}, ${existing.membershipId}, 'probe', 'probe')`;
        realInsertOk = true;
      } catch (error) {
        realInsertCode = error.code ?? "none";
      }
      record(
        "CONTROL: the same insert with a real membership_id still succeeds, so the probe above failed on the null and not on the row",
        realInsertOk,
        realInsertOk ? "" : `sqlstate=${realInsertCode}`,
      );
      await tx.unsafe("ROLLBACK TO SAVEPOINT real_insert_probe");

      const [{ count: afterProbe }] = await tx`SELECT count(*)::int AS count FROM notifications`;
      record(
        "the null-insert probe leaves no residue after its savepoint rolls back",
        afterProbe === rowsBefore,
        `${afterProbe} vs ${rowsBefore}`,
      );

      throw new Error(ROLLBACK_PROBE);
    });
  } catch (error) {
    if (error.message !== ROLLBACK_PROBE) throw error;
  }

  const [{ isNullableAfterRollback }] = await sql`
    SELECT is_nullable AS "isNullableAfterRollback"
      FROM information_schema.columns
     WHERE table_name = 'notifications' AND column_name = 'membership_id'`;
  record(
    "membership_id is nullable again once the transaction rolls back",
    isNullableAfterRollback === "YES",
    `is_nullable=${isNullableAfterRollback}`,
  );

  const [{ count: rowsAfter }] = await sql`SELECT count(*)::int AS count FROM notifications`;
  const [{ size: sizeAfter }] =
    await sql`SELECT pg_size_pretty(pg_total_relation_size('notifications')) AS size`;
  record(
    "row count is unchanged after rollback",
    rowsAfter === rowsBefore,
    `${rowsAfter} vs ${rowsBefore}`,
  );
  console.log(`\nnotifications after: ${rowsAfter} rows, ${sizeAfter}`);

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  await sql.end({ timeout: 5 });
}
