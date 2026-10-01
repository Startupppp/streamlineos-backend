import { sql } from "drizzle-orm";
import { candidateSlaTracking, scheduledReports } from "src/db/schema";
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
});
