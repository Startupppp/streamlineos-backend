/**
 * Real-database regression for the HR dashboard's attendance-rate grain.
 *
 * Guarded by HR_DB_TESTS=1. Run with:
 *   HR_DB_TESTS=1 DATABASE_URL=... npx jest --runInBand \
 *     --testPathPattern="hr-dashboard-attendance-grain.db"
 *
 * `attendance` is a session table — its only unique indexes are on the
 * generated serial, and clockIn blocks only an *open* session before inserting,
 * so one person can hold several rows for one day. The dashboard divided a
 * count of ROWS by employees x working days, so an org whose staff clock out
 * for lunch reported over 100% attendance and, via `100 - attendancePct`,
 * negative absenteeism that `Math.max(0, …)` flattened to a reassuring 0%.
 *
 * This needs a real Postgres: the defect is in what the aggregate counts, and
 * `count(DISTINCT (user_id, date))` against genuine multi-session days is the
 * only way to measure it. It runs the real buildAttendanceAnalytics against
 * seeded rows and removes them afterwards.
 */
import dotenv from "dotenv";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../../../db/schema";
import { buildAttendanceAnalytics } from "../hr-dashboard-attendance";

const ENABLED = process.env.HR_DB_TESTS === "1";
const describeDb = ENABLED ? describe : describe.skip;

/** An org with exactly one active member and no attendance of its own. */
const ORG_ID = "kbprobe-a";

function connect() {
  if (!process.env.DATABASE_URL && !process.env.APP_DATABASE_URL) {
    dotenv.config({ path: ".env" });
  }
  const raw = process.env.DATABASE_URL || process.env.APP_DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL required for HR_DB_TESTS");
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  const ssl = url.hostname === "localhost" || url.hostname === "127.0.0.1" ? false : "require";
  return postgres(url.toString(), { prepare: false, max: 4, ssl, connect_timeout: 30 });
}

/** The first `count` weekdays of the current month that have already happened. */
function elapsedWeekdaysThisMonth(count: number): string[] {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth() + 1;
  const days: string[] = [];
  for (let d = 1; d <= today.getDate() && days.length < count; d++) {
    const dow = new Date(year, month - 1, d).getDay();
    if (dow !== 0 && dow !== 6) {
      days.push(`${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    }
  }
  return days;
}

describeDb("HR dashboard attendance analytics — session grain", () => {
  let sql: ReturnType<typeof connect>;
  let db: ReturnType<typeof drizzle>;
  let days: string[];
  let userId: string;

  beforeAll(async () => {
    sql = connect();
    db = drizzle(sql, { schema });
    days = elapsedWeekdaysThisMonth(2);
    const [member] = await sql<{ user_id: string }[]>`
      SELECT m.user_id FROM organization_members m
        JOIN users u ON u.id = m.user_id
       WHERE m.org_id = ${ORG_ID} AND u.is_active LIMIT 1
    `;
    if (!member) throw new Error(`${ORG_ID} has no active member to seed against`);
    userId = member.user_id;
  });

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM attendance WHERE org_id = ${ORG_ID} AND user_id = ${userId}`;
      await sql.end({ timeout: 5 });
    }
  });

  it("counts one person-day per employee per day, however many sessions they clock", async () => {
    if (days.length < 2) {
      // Runs on the 1st/2nd of a month that starts at a weekend; nothing to prove.
      return;
    }
    const [dayA, dayB] = days as [string, string];

    await sql`DELETE FROM attendance WHERE org_id = ${ORG_ID} AND user_id = ${userId}`;
    // Four rows across two days — a morning session and an after-lunch session
    // on each, which is exactly what clockIn/clockOut/clockIn produces.
    await sql`
      INSERT INTO attendance (org_id, user_id, date, check_in, check_out, status) VALUES
        (${ORG_ID}, ${userId}, ${dayA}, ${dayA + " 10:00:00"}, ${dayA + " 13:00:00"}, 'PRESENT'),
        (${ORG_ID}, ${userId}, ${dayA}, ${dayA + " 14:00:00"}, ${dayA + " 18:00:00"}, 'PRESENT'),
        (${ORG_ID}, ${userId}, ${dayB}, ${dayB + " 08:00:00"}, ${dayB + " 13:00:00"}, 'PRESENT'),
        (${ORG_ID}, ${userId}, ${dayB}, ${dayB + " 14:00:00"}, ${dayB + " 18:00:00"}, 'PRESENT')
    `;

    const [{ count: rowCount }] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM attendance
       WHERE org_id = ${ORG_ID} AND user_id = ${userId}
    `;
    expect(rowCount).toBe(4);

    const result = await buildAttendanceAnalytics(db, ORG_ID);

    expect(result.totalEmployees).toBe(1);
    const denominator = result.totalEmployees * result.workingDaysSoFar;

    // 2 person-days, not the 4 rows that are actually in the table.
    const fromPersonDays = Math.round((2 / denominator) * 100);
    const fromRows = Math.round((4 / denominator) * 100);
    expect(fromPersonDays).not.toBe(fromRows); // the test can tell them apart
    expect(result.attendancePct).toBe(fromPersonDays);

    // The rate stays within bounds and absenteeism is a real number again,
    // rather than a negative one flattened to zero by Math.max.
    expect(result.attendancePct).toBeLessThanOrEqual(100);
    expect(result.absenteeismPct).toBe(100 - fromPersonDays);
    expect(result.absenteeismPct).toBeGreaterThan(0);

    // Late arrivals are person-days too: day A has two post-threshold check-ins
    // (10:00 and the 14:00 return from lunch) but the employee arrived late
    // once; day B's 08:00 start is on time and only its 14:00 return trips the
    // 09:30 threshold. Three qualifying ROWS, two qualifying person-days.
    expect(result.lateArrivals).toBe(2);
  });

  it("reports a rate of zero, not a phantom day, for an org with no attendance", async () => {
    await sql`DELETE FROM attendance WHERE org_id = ${ORG_ID} AND user_id = ${userId}`;
    const result = await buildAttendanceAnalytics(db, ORG_ID);
    expect(result.attendancePct).toBe(0);
    expect(result.absenteeismPct).toBe(100);
    expect(result.lateArrivals).toBe(0);
  });
});
