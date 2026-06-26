import { mint, req } from "./harness.mjs";
const boss = await mint("owner", { role: "CEO" });
import postgres from "../../node_modules/postgres/src/index.js";
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", max: 1 });
const org = "43aa1af7-aa55-4015-85ac-0d86677903f2";
// clean leftovers
const del = await sql`delete from candidates where org_id=${org} and email like 'fn_test_%' returning id`;
console.log("cleaned leftover fn_test ids:", del.map(r=>r.id));
await sql.end();
// now replicate discovery + candidate-scoped, logging
for (let run=1; run<=4; run++){
  const r = await req("GET","/hr/recruitment/candidates",{token:boss});
  const arr = Array.isArray(r.body)? r.body : (r.body?.data ?? []);
  const cid = arr[0]?.id ?? 1;
  // mimic create+delete
  const email = `fn_test_${Date.now()}_${run}@example.com`;
  const cr = await req("POST","/hr/recruitment/candidates",{token:boss,body:{firstName:"FN_TEST_First",lastName:"L",email}});
  const newId = cr.body?.id;
  const dl = await req("DELETE",`/hr/recruitment/candidates/${newId}`,{token:boss});
  // candidate-scoped
  const det = await req("GET",`/hr/recruitment/candidates/${cid}`,{token:boss});
  console.log(`run${run} listStatus=${r.status} arr.len=${arr.length} cid=${cid} createStatus=${cr.status} newId=${newId} delStatus=${dl.status} detailStatus=${det.status}${det.body?.error?" "+det.body.error:""}`);
}
