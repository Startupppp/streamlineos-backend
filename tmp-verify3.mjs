import postgres from "postgres";
import { SignJWT } from "jose";
const sql = postgres(process.env.DATABASE_URL,{prepare:false,max:1});
const fns = await sql`select n.nspname||'.'||p.proname fn from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname like 'search_%_ids' or p.proname like '%_probe%' order by 1`;
console.log("probe functions in DB:", JSON.stringify(fns.map(f=>f.fn)));
const other = await sql`select om.user_id from organization_members om where om.org_id='762942e0-8c2f-45fd-b57a-da971f4b465b' and om.is_owner = true limit 1`;
console.log("other-org owner:", JSON.stringify(other));
await sql.end({timeout:5});

if (other[0]) {
  const secret = new TextEncoder().encode(process.env.BACKEND_JWT_SECRET);
  const tok = await new SignJWT({ sub: other[0].user_id, orgId: "762942e0-8c2f-45fd-b57a-da971f4b465b", sessionId: "s4-x" })
    .setProtectedHeader({alg:"HS256"}).setIssuer("streamlineos-web").setAudience("streamlineos-api")
    .setIssuedAt().setExpirationTime("10m").sign(secret);
  for (const p of ["/build/9/tickets/key/3335","/build/9/tickets/key/101"]) {
    const r = await fetch("http://localhost:1500"+p,{headers:{Authorization:"Bearer "+tok}});
    console.log("cross-tenant (real member of another org)", p.padEnd(30), r.status, (await r.text()).slice(0,100));
  }
}
