import postgres from "../../node_modules/postgres/src/index.js";
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", max: 1 });
const org = "43aa1af7-aa55-4015-85ac-0d86677903f2";
const rows = await sql`select id, first_name, email, created_at from candidates where org_id=${org} order by created_at desc`;
console.log("candidates now:", rows.length);
for (const r of rows) console.log(r.id, r.first_name, r.email, r.created_at.toISOString());
await sql.end();
