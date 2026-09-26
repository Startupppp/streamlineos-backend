import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../../db/schema";
import type { Db } from "../../../db/drizzle.types";
import { ScopedRead } from "../../access/scoped-read";
import { orgBusinessDate } from "../../hr/time/attendance-business-date";
import { snapshotOldValue } from "../../hr/core/hr-effective-changes.helpers";
import { SelfHrTools } from "../../ai/core/tools/self-hr-tools";
import { connectProbe, ReportingProbe } from "./reporting-probe";

jest.setTimeout(120_000);

/**
 * HRM-15: a primary line's `effective_to` is its inclusive last day and `effective_from` its first.
 * Two readers outside the relationship service disagreed with `currentPrimaryReportingLine`: the
 * effective-change snapshot dropped a line on its last day, and the self-service assistant showed a
 * manager who only starts in the future.
 */
describe("current primary line readers agree with currentPrimaryReportingLine", () => {
  let sql: ReturnType<typeof connectProbe>;
  let db: Db;
  let probe: ReportingProbe;
  let today: string;

  beforeAll(async () => {
    sql = connectProbe("current-primary-readers.db.spec.ts");
    db = drizzle(sql, { schema });
    probe = await ReportingProbe.create(sql, "rl-current-readers");
    today = await orgBusinessDate(db, probe.orgId);
  });

  afterAll(async () => {
    if (probe) await probe.drop();
    if (sql) await sql.end({ timeout: 5 });
  });

  it("snapshots the manager of a line whose inclusive last day is today", async () => {
    const employee = await probe.person("last-day");
    const manager = await probe.person("last-day-boss");
    // The snapshot reads "today" as the server's UTC date; the line ends exactly then.
    await probe.line(employee, manager, "2020-01-01", new Date().toISOString().slice(0, 10));

    const snapshot = await snapshotOldValue(
      db,
      probe.orgId,
      { changeType: "manager", managerUserId: manager.userId, effectiveDate: today } as never,
      { id: employee.employmentId, subjectUserId: employee.userId, departmentId: null, designation: null, jobLevelId: null, locationId: null },
    );
    expect(snapshot).toEqual({ managerEmploymentId: manager.employmentId });
  });

  it("does not show the assistant a manager whose line only starts in the future, and shows one in force", async () => {
    const employee = await probe.person("future");
    const later = await probe.person("future-boss");
    await probe.line(employee, later, "2099-01-01");
    const tool = new SelfHrTools(db).tools().find((entry) => entry.key === "getMyEmployment");
    const read = ScopedRead.of(probe.orgId, employee.userId, "own");
    const ctx = {
      actor: { userId: employee.userId, orgId: probe.orgId, today },
      caller: {},
      read,
      readFor: () => read,
      modules: {},
    } as never;

    const future = await tool?.run({}, ctx);
    expect(JSON.stringify(future)).toContain('"manager":null');

    const current = await probe.person("current-boss");
    await probe.line(employee, current, "2020-01-01", "2098-12-31");
    expect(JSON.stringify(await tool?.run({}, ctx))).not.toContain('"manager":null');
  });
});
