import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { CronProjectsService } from "../cron-projects.service";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { BuildTicketCreationService } from "../../build/core/tickets";
import { ProjectsWebhooksDispatchService, BuildAutomationRunnerService } from "../../build/core";
import { CacheService } from "../../../common/cache/cache.service";

jest.mock("../../../common/tenant", () => ({
  ...jest.requireActual("../../../common/tenant"),
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

    const result = await new CronProjectsService(db, {} as unknown as BuildTicketCreationService).spawnDueRecurringTickets();

    expect(result.advanced).toBe(1);
    expect(updateWheres).toHaveLength(1);
    const query = dialect.sqlToQuery(updateWheres[0] as SQL);
    expect(query.sql).toContain('"tickets"."org_id"');
    expect(query.sql).toContain('"tickets"."id"');
    expect(query.params).toContain(ORG);
    expect(query.params).toContain(EXPIRED_TEMPLATE.id);
  });

  it("keeps a due recurrence pending when the destination column is full", async () => {
    const due = { ...EXPIRED_TEMPLATE, recurrenceRule: { frequency: "WEEKLY" }, recurrenceNextRunAt: new Date("2026-01-01") };
    const insert = jest.fn();
    const update = jest.fn();
    const db = {
      select: () => ({ from: () => ({ where: () => ({
        limit: async () => [due],
        groupBy: async () => [{ projectId: 9, maxNumber: 1 }],
      }) }) }),
      selectDistinctOn: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [{ projectId: 9, name: "TODO" }] }) }) }) }),
      execute: async () => [{ name: "TODO", wip_limit: 1, current_count: 1 }],
      transaction: jest.fn(), insert, update,
    };
    db.transaction.mockImplementation(async (work: (tx: typeof db) => Promise<unknown>) => work(db));
    const module = await Test.createTestingModule({
      providers: [
        CronProjectsService,
        BuildTicketCreationService,
        { provide: DRIZZLE, useValue: db },
        { provide: ProjectsWebhooksDispatchService, useValue: { enqueue: jest.fn().mockResolvedValue(undefined) } },
        { provide: BuildAutomationRunnerService, useValue: { runForTicketEvent: jest.fn() } },
        { provide: CacheService, useValue: { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    try {
      await expect(module.get(CronProjectsService).spawnDueRecurringTickets()).resolves.toEqual({ spawned: 0, advanced: 0 });
      expect(insert).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    } finally {
      await module.close();
    }
  });
});
