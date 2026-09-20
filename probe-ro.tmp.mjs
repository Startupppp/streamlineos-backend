import postgres from "postgres";
import { Signer } from "@aws-sdk/rds-signer";
const url = new URL(process.env.DATABASE_URL);
const host=url.hostname, port=Number(url.port||5432), username=decodeURIComponent(url.username);
const password = await new Signer({hostname:host,port,region:process.env.AWS_REGION,username}).getAuthToken();
const sql = postgres({host,port,username,password,database:url.pathname.slice(1),
  ssl:{rejectUnauthorized:false},max:1,prepare:false,connection:{application_name:"askos-ro",TimeZone:"UTC"}});
try {
  await sql`SET default_transaction_read_only = on`;
  const r = await sql`SELECT id, user_id, org_id, role, is_owner FROM organization_members WHERE id IN (9,24)`;
  for (const x of r) console.log(`mid=${x.id} uid=${x.user_id} org=${x.org_id} role=${x.role} owner=${x.is_owner}`);
  const a = await sql`SELECT date::text, status FROM attendance WHERE user_id=(SELECT user_id FROM organization_members WHERE id=9) ORDER BY date`;
  console.log("mid=9 attendance:", a.map(x=>`${x.date}(${x.status})`).join(" "));
} finally { await sql.end(); }
