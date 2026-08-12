import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";
dotenv.config({ path: resolve(process.cwd(), ".env") });
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, ssl: "require", onnotice: () => {} });

const mode = process.argv[2];
const MARK = "ZZ-due-sweep-probe";

if (mode === "seed") {
  const [p] = await sql`select id, org_id from projects where deleted_at is null limit 1`;
  const [m] = await sql`select user_id from organization_members where org_id = ${p.org_id} limit 1`;
  await sql`delete from tickets where title = ${MARK}`;
  const [t] = await sql`insert into tickets (org_id, project_id, title, status, assignee_id, due_date, reporter_id, ticket_number)
    values (${p.org_id}, ${p.id}, ${MARK}, 'TODO', ${m.user_id}, current_date - 1, ${m.user_id},
            (select coalesce(max(ticket_number),0)+1 from tickets where project_id = ${p.id}))
    returning id`;
  console.log(`seeded overdue ticket id=${t.id} org=${p.org_id} assignee=${m.user_id}`);
  console.log(`notifications for assignee before: ${(await sql`select count(*)::int n from notifications where user_id=${m.user_id} and entity_id=${String(t.id)}`)[0].n}`);
}

if (mode === "check") {
  const [t] = await sql`select id, org_id, assignee_id from tickets where title = ${MARK} limit 1`;
  if (!t) { console.log("probe ticket missing"); await sql.end(); process.exit(0); }
  const rows = await sql`select title, category, source_module from notifications
    where entity_id = ${String(t.id)} and entity_type = 'ticket'`;
  console.log(`notifications created for the overdue ticket: ${rows.length}`);
  for (const r of rows) console.log(`   "${r.title}"  [${r.source_module}/${r.category}]`);
}

if (mode === "cleanup") {
  const [t] = await sql`select id from tickets where title = ${MARK} limit 1`;
  if (t) {
    await sql`delete from notifications where entity_id = ${String(t.id)} and entity_type='ticket'`;
    await sql`delete from tickets where id = ${t.id}`;
    console.log(`cleaned up probe ticket ${t.id} and its notifications`);
  } else console.log("nothing to clean");
}

await sql.end();
