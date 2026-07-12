import postgres from "postgres";

const rawUrl = process.env.DATABASE_URL ?? process.env.DB;
const url = rawUrl?.replace(/^['"]|['"]$/g, "");
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const sql = postgres(url, {
  max: 1,
  ssl: url.includes("neon.tech") || url.includes("sslmode=require") ? "require" : undefined,
  prepare: false,
  idle_timeout: 5,
});

const grants = await sql`select count(distinct permission_key)::int as n from role_permission_grants where permission_key like 'crm:%'`;
console.log(`crm grant keys in role_permission_grants: ${grants[0]?.n ?? 0}`);

const orgs = await sql`select count(*)::int as n from organizations`;
console.log(`organizations: ${orgs[0]?.n ?? 0}`);

const pipelines = await sql`select count(*)::int as n, count(distinct org_id)::int as orgs from crm_pipelines`;
console.log(`crm_pipelines rows: ${pipelines[0]?.n ?? 0} across ${pipelines[0]?.orgs ?? 0} orgs`);

const options = await sql`select type, count(*)::int as n from crm_options group by type order by type`;
for (const row of options) console.log(`crm_options ${row.type}: ${row.n}`);

const events = await sql`select count(*)::int as n from crm_automation_events`.catch(() => null);
console.log(`crm_automation_events rows: ${events ? events[0]?.n : "TABLE MISSING"}`);

await sql.end({ timeout: 5 });
