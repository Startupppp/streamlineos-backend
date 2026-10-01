import { eq, sql, type Table } from "drizzle-orm";
import { candidateApplications, candidateSlaTracking, candidates, scheduledReports } from "src/db/schema";
import { worldDb, type Row } from "./world-db";
import { evaluate, scalar, type Lookup } from "./world-db-sql";
import { UnsupportedQuery } from "./world-db-values";

const HOUR = 3_600_000;

function rowLookup(values: Readonly<Record<string, unknown>>): Lookup {
  return (column) => values[column.name];
}

describe("world-db value expressions", () => {
  const breached = (enteredAt: Date): unknown =>
    evaluate(sql`${candidateSlaTracking.enteredAt} < now() - (${48} || ' hours')::interval`, rowLookup({ entered_at: enteredAt }));

  it("subtracts a concatenated interval from now() so a clock older than the limit breaches and a fresh one does not", () => {
    expect(breached(new Date(Date.now() - 49 * HOUR))).toBe(true);
    expect(breached(new Date(Date.now() - 47 * HOUR))).toBe(false);
  });

  it("picks the matching CASE arm and falls back to ELSE, so a monthly cadence and a weekly cadence differ", () => {
    const cadence = sql`(CASE ${scheduledReports.schedule} WHEN 'MONTHLY' THEN ${30} ELSE ${7} END || ' days')::interval`;
    const due = (schedule: string, lastRunAt: Date): unknown =>
      evaluate(sql`${scheduledReports.lastRunAt} <= now() - ${cadence}`, rowLookup({ schedule, last_run_at: lastRunAt }));
    const tenDaysAgo = new Date(Date.now() - 240 * HOUR);
    expect(due("WEEKLY", tenDaysAgo)).toBe(true);
    expect(due("MONTHLY", tenDaysAgo)).toBe(false);
  });

  it("renders to_char at UTC with microseconds exactly as the keyset cursors encode it", () => {
    const at = new Date("2026-09-15T09:30:00.123Z");
    const rendered = scalar(sql`to_char(${candidateSlaTracking.enteredAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`, rowLookup({ entered_at: at }));
    expect(rendered).toBe("2026-09-15T09:30:00.123000");
  });

  it("refuses what it cannot model faithfully rather than guessing", () => {
    const lookup = rowLookup({ entered_at: new Date() });
    expect(() => scalar(sql`to_char(${candidateSlaTracking.enteredAt} AT TIME ZONE 'UTC', 'DD Mon YYYY')`, lookup)).toThrow(UnsupportedQuery);
    expect(() => evaluate(sql`${candidateSlaTracking.enteredAt} < now() - ('two weeks')::interval`, lookup)).toThrow(UnsupportedQuery);
    expect(() => evaluate(sql`${candidateSlaTracking.enteredAt} < now() - now()`, lookup)).toThrow(UnsupportedQuery);
    expect(() => evaluate(sql`${candidateSlaTracking.enteredAt} < (${1})::timestamp`, lookup)).toThrow(UnsupportedQuery);
  });

  const applications = (): ReturnType<typeof worldDb> =>
    worldDb(
      new Map([
        [
          candidateApplications,
          [
            { id: 1, orgId: "a", status: "APPLIED" },
            { id: 2, orgId: "a", status: "ACCEPTED" },
            { id: 3, orgId: "b", status: "ACCEPTED" },
          ],
        ],
      ]),
    );

  it("aggregates an implicit group, honouring the filter clause and the tenant predicate, and answers zero over no rows", async () => {
    const fields = { applied: sql<number>`count(*)::int`, hired: sql<number>`count(*) filter (where ${candidateApplications.status} = 'ACCEPTED')::int` };
    const db = applications().db;
    expect(await db.select(fields).from(candidateApplications).where(eq(candidateApplications.orgId, "a"))).toEqual([{ applied: 2, hired: 1 }]);
    expect(await db.select(fields).from(candidateApplications).where(eq(candidateApplications.orgId, "c"))).toEqual([{ applied: 0, hired: 0 }]);
  });

  it("groups by a column and orders by an aggregate", async () => {
    const rows = await applications()
      .db.select({ orgId: candidateApplications.orgId, total: sql<number>`count(distinct ${candidateApplications.id})::int` })
      .from(candidateApplications)
      .groupBy(candidateApplications.orgId)
      .orderBy(sql`count(*) desc`);
    expect(rows).toEqual([
      { orgId: "a", total: 2 },
      { orgId: "b", total: 1 },
    ]);
  });

  it("rejects a bare column that is neither grouped nor aggregated, and an integer division whose two semantics disagree", async () => {
    const db = applications().db;
    await expect(db.select({ status: candidateApplications.status, total: sql<number>`count(*)` }).from(candidateApplications)).rejects.toThrow(UnsupportedQuery);
    await expect(db.select({ half: sql<number>`count(*) / 2` }).from(candidateApplications)).rejects.toThrow(UnsupportedQuery);
  });

  it("resolves a raw-named, aliased, correlated count subquery and refuses a raw table it cannot tell apart or does not know", async () => {
    const world = worldDb(
      new Map<Table, Row[]>([
        [candidates, [{ id: 7, orgId: "a" }]],
        [
          candidateApplications,
          [
            { id: 1, orgId: "a", status: "APPLIED" },
            { id: 2, orgId: "a", status: "REJECTED" },
            { id: 3, orgId: "b", status: "APPLIED" },
          ],
        ],
      ]),
    );
    const peers = (table: string, outer: typeof candidates.orgId | typeof candidateApplications.orgId) =>
      world.db
        .select({ peers: sql<number>`(SELECT count(*)::int FROM ${sql.raw(table)} r WHERE r.org_id = ${outer} AND r.status IN ('APPLIED', 'ACCEPTED'))` })
        .from(candidates);
    expect(await peers("candidate_applications", candidates.orgId)).toEqual([{ peers: 1 }]);
    await expect(peers("candidate_applications", candidateApplications.orgId)).rejects.toThrow(UnsupportedQuery);
    await expect(peers("no_such_table", candidates.orgId)).rejects.toThrow(UnsupportedQuery);
  });
});
