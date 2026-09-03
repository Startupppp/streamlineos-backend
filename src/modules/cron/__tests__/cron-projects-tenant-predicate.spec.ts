import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { CronProjectsService } from "../cron-projects.service";

jest.mock("../../../common/tenant", () => ({
  forEachOrg: (db: unknown, _label: string, fn: (tx: unknown, orgId: string) => Promise<void>) =>
    fn(db, "org-sweeping"),
}));

const dialect = new PgDialect();
const ORG = "org-sweeping";

const EXPIRED_TEMPLATE = {
  id: 41,
  orgId: ORG,
  projectId: 9,
  title: "Weekly report",
  description: null,
  type: "TASK",
  priority: "MEDIUM",
  points: null,
  assigneeMembershipId: null,
  recurrenceRule: { frequency: "WEEKLY", endDate: "2020-01-01" },
  recurrenceNextRunAt: new Date("2019-01-01"),
};

function makeDb(rows: unknown[]) {
  const updateWheres: SQL[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(rows) }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: (condition: SQL) => {
          updateWheres.push(condition);
          return Promise.resolve([]);
        },
      }),
    }),
  } as unknown as Db;
  return { db, updateWheres };
}

describe("CronProjectsService — the recurrence advance keeps the organisation it read under", () => {
  it("stops a past-end-date template with org_id AND id, never the surrogate id alone", async () => {
    const { db, updateWheres } = makeDb([EXPIRED_TEMPLATE]);

    const result = await new CronProjectsService(db).spawnDueRecurringTickets();

    expect(result.advanced).toBe(1);
    expect(updateWheres).toHaveLength(1);
    const query = dialect.sqlToQuery(updateWheres[0] as SQL);
    expect(query.sql).toContain('"tickets"."org_id"');
    expect(query.sql).toContain('"tickets"."id"');
    expect(query.params).toContain(ORG);
    expect(query.params).toContain(EXPIRED_TEMPLATE.id);
  });
});
