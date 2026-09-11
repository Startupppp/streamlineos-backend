/**
 * Real-database regression for the HR dashboard's attendance-rate grain.
 *
 * Run with `pnpm test:db-specs` or:
 *   DATABASE_URL=... node ./node_modules/jest/bin/jest.js --config jest-db.json --runInBand \
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
import { requireApprovedDatabaseUrl } from "../../../../test/db-spec-guard";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.types";
import { buildAttendanceAnalytics } from "../hr-dashboard-attendance";
import { createProbeOrg, dropProbeOrg, type ProbeOrg } from "../../../../../test/helpers/probe-org";

function connect() {
  const raw = requireApprovedDatabaseUrl({
    spec: "hr-dashboard-attendance-grain.db.spec.ts",
    vars: ["DATABASE_URL", "APP_DATABASE_URL"],
  });
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

describe("HR dashboard attendance analytics — session grain", () => {
  let sql: ReturnType<typeof connect>;
  let db: Db;
  let days: string[];
  let probe: ProbeOrg;
  let ORG_ID: string;
  let userId: string;

  beforeAll(async () => {
    sql = connect();
    db = drizzle(sql, { schema });
    days = elapsedWeekdaysThisMonth(2);
    // The denominator this suite asserts against is `active members x working days`, so the
    // org has to hold exactly one active member for the arithmetic to be exact. It is built
    // here rather than looked up, which is what makes the suite runnable on any database at
    // journal head instead of on the one machine that happened to have the right org.
    probe = await createProbeOrg(sql, "hr-attendance-grain");
    ORG_ID = probe.orgId;
    userId = probe.userId;
  }, 60_000);

  afterAll(async () => {
    if (sql) {
      if (probe) await dropProbeOrg(sql, probe, ["attendance"]);
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  it("counts one person-day per employee per day, however many sessions they clock", async () => {
    // No early return. This used to `return` when the month was too young to have
    // two elapsed weekdays — on the 1st or 2nd of a month starting at a weekend the
    // test silently passed having asserted nothing, which is the one outcome a
    // regression net must never have. The numbers below are derived from
    // `days.length` instead, so the same invariant is proved with one day or two.
    expect(days.length).toBeGreaterThan(0);

    await sql`DELETE FROM attendance WHERE org_id = ${ORG_ID} AND user_id = ${userId}`;
    // Two sessions per day — a morning and an after-lunch block, exactly what
    // clockIn/clockOut/clockIn produces. Day A starts late (10:00) and day B on
    // time (08:00), so across two days three ROWS trip the 09:30 threshold while
    // only two PERSON-DAYS do. That gap is the whole point of the test, and it is
    // still present with one day (two late rows, one late person-day).
    for (const [i, day] of days.entries()) {
      const firstIn = i === 1 ? "08:00:00" : "10:00:00";
      await sql`
        INSERT INTO attendance (org_id, user_id, date, check_in, check_out, status) VALUES
          (${ORG_ID}, ${userId}, ${day}, ${day + " " + firstIn}, ${day + " 13:00:00"}, 'PRESENT'),
          (${ORG_ID}, ${userId}, ${day}, ${day + " 14:00:00"}, ${day + " 18:00:00"}, 'PRESENT')
      `;
    }

    const [{ count: rowCount }] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM attendance
       WHERE org_id = ${ORG_ID} AND user_id = ${userId}
    `;
    const personDays = days.length;
    expect(rowCount).toBe(personDays * 2);

    const result = await buildAttendanceAnalytics(db, ORG_ID);

    expect(result.totalEmployees).toBe(1);
    const denominator = result.totalEmployees * result.workingDaysSoFar;

    // person-days, not the rows that are actually in the table.
    const fromPersonDays = Math.round((personDays / denominator) * 100);
    const fromRows = Math.round((rowCount / denominator) * 100);
    expect(fromPersonDays).not.toBe(fromRows); // the test can tell them apart
    expect(result.attendancePct).toBe(fromPersonDays);

    // The rate stays within bounds and absenteeism is a real number again,
    // rather than a negative one flattened to zero by Math.max.
    expect(result.attendancePct).toBeLessThanOrEqual(100);
    expect(result.absenteeismPct).toBe(100 - fromPersonDays);
    expect(result.absenteeismPct).toBeGreaterThan(0);

    // Late arrivals are person-days too: day A's 10:00 start and its 14:00 return
    // from lunch are two post-threshold check-ins but one late day.
    expect(result.lateArrivals).toBe(personDays);

    // And the gap is real rather than incidental: strictly more ROWS trip the
    // threshold than person-days do, which is what a row-grained count would
    // have reported instead.
    const [{ count: lateRows }] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM attendance
       WHERE org_id = ${ORG_ID} AND user_id = ${userId}
         AND check_in::time > '09:30:00'
    `;
    expect(lateRows).toBeGreaterThan(result.lateArrivals);
  });

  it("reports a rate of zero, not a phantom day, for an org with no attendance", async () => {
    await sql`DELETE FROM attendance WHERE org_id = ${ORG_ID} AND user_id = ${userId}`;
    const result = await buildAttendanceAnalytics(db, ORG_ID);
    expect(result.attendancePct).toBe(0);
    expect(result.absenteeismPct).toBe(100);
    expect(result.lateArrivals).toBe(0);
  });
});
