import postgres from "../../node_modules/postgres/src/index.js";
import { drizzle } from "../../node_modules/drizzle-orm/postgres-js/index.js";
import { and, eq, isNotNull, sql } from "../../node_modules/drizzle-orm/index.js";
import * as schema from "../../dist/db/schema/index.js";
const client = postgres(process.env.DATABASE_URL, { ssl: "require", max: 1 });
const db = drizzle(client, { schema });
const { interviewScorecards, interviews, users } = schema;
const org = "43aa1af7-aa55-4015-85ac-0d86677903f2";
const since = new Date(Date.now()-90*864e5);
try {
  const rows = await db.select({
    interviewerId: interviewScorecards.interviewerId,
    interviewerName: users.name,
    interviewerEmail: users.email,
    scorecardSubmittedAt: interviewScorecards.submittedAt,
    interviewScheduledAt: interviews.scheduledAt,
    recommendation: interviewScorecards.recommendation,
  })
  .from(interviewScorecards)
  .innerJoin(interviews, eq(interviewScorecards.interviewId, interviews.id))
  .innerJoin(users, eq(interviewScorecards.interviewerId, users.id))
  .where(and(eq(interviews.orgId, org), isNotNull(interviewScorecards.submittedAt), sql`${interviews.scheduledAt} >= ${since}`));
  console.log("drizzle query OK rows=", rows.length);
} catch(e){ console.log("drizzle ERR:", e.message, "\n", e.stack?.split("\n").slice(0,4).join("\n")); }
await client.end();
