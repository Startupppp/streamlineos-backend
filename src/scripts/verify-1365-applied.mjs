import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const TAG = "1365_magic_link_tokens_org_id";
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
const results = [];
const record = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

try {
  const [column] = await sql`
    SELECT data_type AS "dataType", is_nullable AS "isNullable"
      FROM information_schema.columns
     WHERE table_name = 'magic_link_tokens' AND column_name = 'org_id'`;
  record("org_id exists as nullable text", column?.dataType === "text" && column?.isNullable === "YES",
    column ? `${column.dataType}, nullable=${column.isNullable}` : "column absent");

  const [fk] = await sql`
    SELECT convalidated AS "validated", confdeltype AS "onDelete" FROM pg_constraint
     WHERE conname = 'magic_link_tokens_org_id_organizations_id_fk' AND contype = 'f'`;
  record("the foreign key exists and is validated", fk?.validated === true,
    fk ? `convalidated=${fk.validated}, confdeltype=${fk.onDelete}` : "constraint absent");

  const [index] = await sql`
    SELECT indexdef AS "def" FROM pg_indexes
     WHERE tablename = 'magic_link_tokens' AND indexname = 'idx_magic_link_tokens_org'`;
  record("the org lookup index exists", Boolean(index), index?.def ?? "index absent");

  const onDisk = createHash("sha256")
    .update(readFileSync(join(process.cwd(), "migrations", `${TAG}.sql`), "utf8"))
    .digest("hex");
  const [ledger] = await sql`
    SELECT hash, created_at AS "createdAt" FROM drizzle.__drizzle_migrations
     ORDER BY created_at DESC LIMIT 1`;
  record("the ledger's newest row is this migration, hashed from the file on disk",
    ledger?.hash === onDisk, `ledger=${ledger?.hash?.slice(0, 12)}… disk=${onDisk.slice(0, 12)}…`);

  const [{ count: nonNull }] = await sql`
    SELECT count(*)::int AS count FROM magic_link_tokens WHERE org_id IS NOT NULL`;
  record("every existing token is org-neutral, so no live token changed meaning", nonNull === 0,
    `${nonNull} rows carry an org_id`);

  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  await sql.end();
}
