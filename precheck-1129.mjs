import fs from "node:fs";
import postgres from "postgres";

const env = fs.readFileSync(".env", "utf8");
const m = env.match(/^DATABASE_URL=['"]?([^'"\r\n]+)['"]?$/m);
if (!m) { console.error("no DATABASE_URL"); process.exit(1); }
const sql = postgres(m[1], { max: 1, prepare: false, ssl: { rejectUnauthorized: false } });

try {
  const host = new URL(m[1]).host;
  console.log("TARGET HOST:", host);

  const tbl = await sql`SELECT to_regclass('public.onboarding_flow_sessions') AS t`;
  console.log("table onboarding_flow_sessions:", tbl[0].t);
  if (!tbl[0].t) { console.log("ABORT: table absent"); process.exit(0); }

  const idx = await sql`
    SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname='public' AND tablename='onboarding_flow_sessions'
    ORDER BY indexname`;
  console.log("\nEXISTING INDEXES:");
  for (const r of idx) console.log("  " + r.indexname + "\n      " + r.indexdef);

  const total = await sql`SELECT count(*)::int AS c FROM onboarding_flow_sessions`;
  console.log("\nrow count:", total[0].c);

  const dupMembership = await sql`
    SELECT org_id, membership_id, type, count(*)::int AS c
    FROM onboarding_flow_sessions
    WHERE membership_id IS NOT NULL AND status <> 'abandoned'
    GROUP BY 1,2,3 HAVING count(*) > 1 ORDER BY c DESC LIMIT 20`;
  console.log("\nCONFLICTS for uq_onb_flow_sessions_membership_type:", dupMembership.length);
  for (const r of dupMembership) console.log("  ", JSON.stringify(r));

  const dupUser = await sql`
    SELECT org_id, user_id, type, count(*)::int AS c
    FROM onboarding_flow_sessions
    WHERE membership_id IS NULL AND status <> 'abandoned'
    GROUP BY 1,2,3 HAVING count(*) > 1 ORDER BY c DESC LIMIT 20`;
  console.log("\nCONFLICTS for uq_onb_flow_sessions_user_type:", dupUser.length);
  for (const r of dupUser) console.log("  ", JSON.stringify(r));

  const statuses = await sql`SELECT status, count(*)::int AS c FROM onboarding_flow_sessions GROUP BY 1 ORDER BY 2 DESC`;
  console.log("\nstatus distribution:", JSON.stringify(statuses));
} catch (e) {
  console.error("ERROR:", e.message, e.code ?? "");
} finally {
  await sql.end({ timeout: 5 });
}
