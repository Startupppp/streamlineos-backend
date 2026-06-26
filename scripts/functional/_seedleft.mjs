import postgres from "../../node_modules/postgres/src/index.js";
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", max: 1 });
const org = "43aa1af7-aa55-4015-85ac-0d86677903f2";
const ins = await sql`insert into candidates (org_id, first_name, last_name, email, created_at, updated_at)
  values (${org},'FN_TEST_First','Leftover',${'fn_test_left_'+Date.now()+'@example.com'}, now(), now()) returning id`;
console.log("seeded leftover id:", ins[0].id);
await sql.end();
