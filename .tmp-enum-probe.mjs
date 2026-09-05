import postgres from "postgres";
import { readFileSync } from "node:fs";

const uri = readFileSync(process.argv[2], "utf8").trim();
const sql = postgres(uri, { max: 1, prepare: false, ssl: "require", onnotice: () => {} });
try {
  const col = await sql`
    SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
    FROM pg_attribute a
    JOIN pg_type t ON t.oid = a.atttypid
    LEFT JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE a.attrelid = 'helpdesk_tickets'::regclass AND a.attname = 'status'
    GROUP BY t.typname`;
  process.stdout.write(`helpdesk_tickets.status type=${col[0]?.typname} labels=${JSON.stringify(col[0]?.labels)}\n`);

  try {
    const r = await sql`SELECT count(*)::int AS n FROM helpdesk_tickets WHERE status IN ('RESOLVED','CLOSED')`;
    process.stdout.write(`predicate matched ${r[0].n} rows (no error)\n`);
  } catch (err) {
    process.stdout.write(`PREDICATE THREW: code=${err.code} message=${String(err.message).slice(0, 200)}\n`);
  }
} finally {
  await sql.end();
}
