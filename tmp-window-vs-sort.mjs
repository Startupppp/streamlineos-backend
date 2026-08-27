import postgres from "postgres";
const ORG = "aa5627a2-a7de-4dca-97d2-135f3a5f801b";
const sql = postgres(process.env.APP_DATABASE_URL, { prepare: false, max: 1, connect_timeout: 20 });
function sum(plan){let b=0,n=[];const w=p=>{b+=(p["Shared Hit Blocks"]??0)+(p["Shared Read Blocks"]??0);n.push(p["Node Type"]+(p["Index Name"]?` [${p["Index Name"]}]`:""));(p["Plans"]??[]).forEach(w)};w(plan[0]["Plan"]);return{b,ms:plan[0]["Execution Time"],n}}
async function run(label, q){
  try{
    const out = await sql.begin(async tx=>{
      await tx.unsafe(`SELECT set_config('app.organization_id','${ORG}',true), set_config('app.audience','member',true)`);
      return tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q}`);
    });
    const s=sum(out[0]["QUERY PLAN"]);
    console.log(label.padEnd(46)+`blocks=${String(s.b).padStart(6)}  ${s.ms.toFixed(1)}ms  ${s.n.slice(0,3).join(" > ")}`);
  }catch(e){console.log(label.padEnd(46)+"ERR "+e.code+" "+e.message.slice(0,70));}
}
const W = `WHERE t.org_id='${ORG}' AND t.project_id=9 AND t.deleted_at IS NULL`;
await run("rank + count(*) OVER ()", `SELECT t.id, count(*) OVER () total FROM build.tickets t ${W} ORDER BY t.rank ASC, t.created_at DESC, t.id ASC LIMIT 50`);
await run("rank, NO window", `SELECT t.id FROM build.tickets t ${W} ORDER BY t.rank ASC, t.created_at DESC, t.id ASC LIMIT 50`);
await run("rank only (no tiebreak), NO window", `SELECT t.id FROM build.tickets t ${W} ORDER BY t.rank ASC LIMIT 50`);
await run("created + count(*) OVER ()", `SELECT t.id, count(*) OVER () total FROM build.tickets t ${W} ORDER BY t.created_at DESC, t.id ASC LIMIT 50`);
await run("created, NO window", `SELECT t.id FROM build.tickets t ${W} ORDER BY t.created_at DESC, t.id ASC LIMIT 50`);
await run("bare count(*) only", `SELECT count(*) FROM build.tickets t ${W}`);
await sql.end({ timeout: 5 });
