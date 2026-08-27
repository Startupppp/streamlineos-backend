import postgres from "postgres";
const ORG="aa5627a2-a7de-4dca-97d2-135f3a5f801b";
const sql=postgres(process.env.APP_DATABASE_URL,{prepare:false,max:1,connect_timeout:20});
function sum(p){let b=0,n=[];const w=x=>{b+=(x["Shared Hit Blocks"]??0)+(x["Shared Read Blocks"]??0);n.push(x["Node Type"]+(x["Index Name"]?` [${x["Index Name"]}]`:""));(x["Plans"]??[]).forEach(w)};w(p[0]["Plan"]);return{b,n}}
const W=`WHERE t.org_id='${ORG}' AND t.project_id=9 AND t.deleted_at IS NULL`;
for(const [k,o] of Object.entries({rank:"t.rank ASC, t.created_at DESC, t.id ASC",created:"t.created_at DESC, t.created_at DESC, t.id ASC",updated:"t.updated_at DESC, t.created_at DESC, t.id ASC",priority:"t.priority ASC, t.created_at DESC, t.id ASC",dueDate:"t.due_date ASC, t.created_at DESC, t.id ASC"})){
  const out=await sql.begin(async tx=>{await tx.unsafe(`SELECT set_config('app.organization_id','${ORG}',true), set_config('app.audience','member',true)`);return tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT t.id FROM build.tickets t ${W} ORDER BY ${o} LIMIT 50`)});
  const s=sum(out[0]["QUERY PLAN"]);
  console.log(k.padEnd(9)+`blocks=${String(s.b).padStart(6)}  ${s.n.slice(0,3).join(" > ")}`);
}
await sql.end({timeout:5});
