import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const TAG = "1365_magic_link_tokens_org_id";
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

try {
  const [{ count: rowCount }] = await sql`SELECT count(*)::int AS count FROM magic_link_tokens`;
  const [{ size }] = await sql`SELECT pg_size_pretty(pg_total_relation_size('magic_link_tokens')) AS size`;
  console.log(`\nmagic_link_tokens before: ${rowCount} rows, ${size}\n`);

  const [{ exists: columnBefore }] = await sql`
    SELECT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_name = 'magic_link_tokens' AND column_name = 'org_id') AS exists`;
  record("org_id is absent before the migration runs", columnBefore === false);

  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL lock_timeout = '3s'");
      await tx.unsafe("SET LOCAL statement_timeout = '15s'");
      for (const statement of statements) await tx.unsafe(statement);

      const [{ dataType, isNullable }] = await tx`
        SELECT data_type AS "dataType", is_nullable AS "isNullable"
          FROM information_schema.columns
         WHERE table_name = 'magic_link_tokens' AND column_name = 'org_id'`;
      record("adds org_id as a nullable text column", dataType === "text" && isNullable === "YES",
        `${dataType}, nullable=${isNullable}`);

      const [{ count: fkCount }] = await tx`
        SELECT count(*)::int AS count FROM pg_constraint
         WHERE conname = 'magic_link_tokens_org_id_organizations_id_fk' AND contype = 'f'`;
      record("creates the foreign key to organizations", fkCount === 1);

      const [{ count: idxCount }] = await tx`
        SELECT count(*)::int AS count FROM pg_indexes
         WHERE tablename = 'magic_link_tokens' AND indexname = 'idx_magic_link_tokens_org'`;
      record("creates the org lookup index", idxCount === 1);

      const [anchor] = await tx`
        SELECT m.user_id AS "userId", m.org_id AS "orgId"
          FROM organization_members m
          JOIN organizations o ON o.id = m.org_id
          JOIN users u ON u.id = m.user_id
         LIMIT 1`;
      if (!anchor) throw new Error("no organization_members row to anchor the probes on");

      let bitesOnBogusOrg = false;
      try {
        await tx.savepoint(async (sp) => {
          await sp`INSERT INTO magic_link_tokens (id, user_id, token_hash, expires_at, org_id)
                   VALUES ('probe-bogus', ${anchor.userId}, 'probe-bogus-hash', now() + interval '1 hour',
                           'org-that-does-not-exist')`;
        });
      } catch (error) {
        bitesOnBogusOrg = error.code === "23503";
      }
      record("the foreign key bites: a token cannot name an org that does not exist", bitesOnBogusOrg);

      let acceptsRealOrg = false;
      await tx.savepoint(async (sp) => {
        await sp`INSERT INTO magic_link_tokens (id, user_id, token_hash, expires_at, org_id)
                 VALUES ('probe-real', ${anchor.userId}, 'probe-real-hash', now() + interval '1 hour',
                         ${anchor.orgId})`;
        const [{ count }] = await sp`
          SELECT count(*)::int AS count FROM magic_link_tokens
           WHERE id = 'probe-real' AND org_id = ${anchor.orgId}`;
        acceptsRealOrg = count === 1;
      });
      record("a token minted against a real org is accepted and reads back scoped", acceptsRealOrg);

      let acceptsNull = false;
      await tx.savepoint(async (sp) => {
        await sp`INSERT INTO magic_link_tokens (id, user_id, token_hash, expires_at)
                 VALUES ('probe-null', ${anchor.userId}, 'probe-null-hash', now() + interval '1 hour')`;
        const [{ count }] = await sp`
          SELECT count(*)::int AS count FROM magic_link_tokens WHERE id = 'probe-null' AND org_id IS NULL`;
        acceptsNull = count === 1;
      });
      record("an org-neutral mint still inserts with no org_id, so self-service sign-in is untouched", acceptsNull);

      throw new Error("ROLLBACK_PROBE");
    });
  } catch (error) {
    if (error.message !== "ROLLBACK_PROBE") throw error;
  }

  const [{ exists: columnAfter }] = await sql`
    SELECT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_name = 'magic_link_tokens' AND column_name = 'org_id') AS exists`;
  record("the rollback left no org_id column behind", columnAfter === false);

  const [{ count: rowsAfter }] = await sql`SELECT count(*)::int AS count FROM magic_link_tokens`;
  record("the rollback left the row count unchanged", rowsAfter === rowCount, `${rowCount} -> ${rowsAfter}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} finally {
  await sql.end();
}
