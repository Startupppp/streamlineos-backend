import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, sql as dsql } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";
import * as schema from "../../../db/schema";
import { hrReportingLines } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.types";
import { currentPrimaryReportingLine, orgBusinessDateSql } from "../employment-query";
import { connectProbe, ReportingProbe } from "./reporting-probe";

jest.setTimeout(120_000);

/**
 * HRM-15: every line is written starting on the organization's business date, but the readers
 * compared it with the session's CURRENT_DATE (UTC for the app role). Between the org's midnight
 * and UTC midnight a line written "today" was invisible to approval routing, /me/team and the org
 * chart. The readers now ask the database for the org's own date.
 */
describe("org business date in SQL", () => {
  let sql: ReturnType<typeof connectProbe>;
  let db: Db;
  let probe: ReportingProbe;

  beforeAll(async () => {
    sql = connectProbe("org-business-date.db.spec.ts");
    db = drizzle(sql, { schema });
    probe = await ReportingProbe.create(sql, "org-business-date");
  });

  afterAll(async () => {
    if (probe) await probe.drop();
    if (sql) await sql.end({ timeout: 5 });
  });

  async function sqlDate(): Promise<string> {
    const [row] = await db.execute<{ d: string }>(dsql`SELECT ${orgBusinessDateSql(probe.orgId)}::text AS d`);
    return row?.d ?? "";
  }

  it.each(["Pacific/Kiritimati", "Etc/GMT+12", "Asia/Kolkata", "UTC"])("matches the org's local date in %s", async (timezone) => {
    await sql`UPDATE organizations SET timezone = ${timezone} WHERE id = ${probe.orgId}`;
    expect(await sqlDate()).toBe(formatInTimeZone(new Date(), timezone, "yyyy-MM-dd"));
  });

  it("falls back to the session date for a timezone the database does not know, instead of failing the read", async () => {
    await sql`UPDATE organizations SET timezone = ${"Mars/Olympus_Mons"} WHERE id = ${probe.orgId}`;
    const [row] = await sql<{ d: string }[]>`SELECT CURRENT_DATE::text AS d`;
    expect(await sqlDate()).toBe(row?.d);
  });

  it("treats a line starting on the org's local today as current, whatever the UTC date is", async () => {
    await sql`UPDATE organizations SET timezone = ${"Pacific/Kiritimati"} WHERE id = ${probe.orgId}`;
    const localToday = formatInTimeZone(new Date(), "Pacific/Kiritimati", "yyyy-MM-dd");
    const employee = await probe.person("kiritimati");
    const manager = await probe.person("kiritimati-boss");
    const lineId = await probe.line(employee, manager, localToday);

    const current = await db
      .select({ id: hrReportingLines.id })
      .from(hrReportingLines)
      .where(and(currentPrimaryReportingLine(probe.orgId), eq(hrReportingLines.id, lineId)));
    expect(current).toEqual([{ id: lineId }]);
  });
});
