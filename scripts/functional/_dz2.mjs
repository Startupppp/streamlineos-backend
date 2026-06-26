import postgres from "../../node_modules/postgres/src/index.js";
import { drizzle } from "../../node_modules/drizzle-orm/postgres-js/index.js";
import { and, eq, isNotNull, gte, sql } from "../../node_modules/drizzle-orm/index.js";
import * as schema from "../../dist/db/schema/index.js";
const client = postgres(process.env.DATABASE_URL, { ssl: "require", max: 1 });
const db = drizzle(client, { schema });
const { interviewScorecards, interviews, users } = schema;
const org = "43aa1af7-aa55-4015-85ac-0d86677903f2";
const since = new Date(Date.now()-90*864e5);
async function trySql(label, whereExpr){
  try {
    const rows = await db.select({ id: interviews.id })
      .from(interviews).where(whereExpr);
    console.log(label, "OK rows=", rows.length);
  } catch(e){ console.log(label, "ERR cause:", e.cause?.message || e.message); }
}
await trySql("sql-template Date", sql`${interviews.scheduledAt} >= ${since}`);
await trySql("gte helper Date", gte(interviews.scheduledAt, since));
await trySql("sql-template ISO string", sql`${interviews.scheduledAt} >= ${since.toISOString()}`);
await client.end();
