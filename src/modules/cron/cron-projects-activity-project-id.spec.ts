jest.mock("../../common/tenant", () => ({
  forEachOrg: jest.fn(),
}));

import { Test, type TestingModule } from "@nestjs/testing";
import { forEachOrg } from "../../common/tenant";
import type { TenantTx } from "../../common/tenant";
import { DRIZZLE } from "../../db/drizzle.constants";
import { CronProjectsService } from "./cron-projects.service";

const mockForEachOrg = jest.mocked(forEachOrg);

const ORG_ID = "org-cron-1";
const PROJECT_ID = 7;
const TEMPLATE_ID = 100;
const SPAWNED_TICKET_ID = 200;

interface CapturedInsert {
  table: unknown;
  valuesArg: unknown;
}

function makeInnerTxWithCapture(): {
  innerTx: TenantTx;
  getCapturedInserts: () => CapturedInsert[];
} {
  const captured: CapturedInsert[] = [];

  const selectChain = {
    where: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockResolvedValue([
      { projectId: PROJECT_ID, maxNumber: 1 },
    ]),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([
      { projectId: PROJECT_ID, name: "TODO" },
    ]),
  };

  const innerTx = {
    select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue(selectChain) }),
    selectDistinctOn: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue(selectChain) }),
    insert: jest.fn().mockImplementation((table: unknown) => {
      let capturedValues: unknown = undefined;
      const entry: CapturedInsert = { table, valuesArg: undefined };
      captured.push(entry);
      return {
        values: jest.fn().mockImplementation((v: unknown) => {
          entry.valuesArg = v;
          return {
            returning: jest.fn().mockResolvedValue(
              [{ id: SPAWNED_TICKET_ID, projectId: PROJECT_ID, assigneeMembershipId: null }],
            ),
            onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
            then: (resolve: (v: typeof capturedValues) => unknown) => Promise.resolve(capturedValues).then(resolve),
          };
        }),
      };
    }),
    execute: jest.fn().mockResolvedValue([]),
    transaction: jest.fn().mockImplementation(
      async (cb: (tx: TenantTx) => Promise<unknown>) => cb(innerTx as unknown as TenantTx),
    ),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue([]),
  } as unknown as TenantTx;

  return { innerTx, getCapturedInserts: () => captured };
}

const RECURRING_RULE = {
  frequency: "daily" as const,
  interval: 1,
  endDate: null,
};

const TEMPLATE_ROW = {
  id: TEMPLATE_ID,
  orgId: ORG_ID,
  projectId: PROJECT_ID,
  title: "Daily sync",
  description: null,
  type: "TASK" as const,
  priority: "MEDIUM" as const,
  points: null,
  assigneeMembershipId: null,
  recurrenceRule: RECURRING_RULE,
  recurrenceNextRunAt: new Date("2025-01-01T00:00:00Z"),
};

describe("CronProjectsService — project_id set on spawned activity log (ticket 16 writer coverage)", () => {
  let service: CronProjectsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CronProjectsService,
        { provide: DRIZZLE, useValue: {} },
      ],
    }).compile();
    service = module.get(CronProjectsService);
  });

  it("spawnDueRecurringTickets sets project_id on the activity log entry from the spawned ticket's project_id so recurring-ticket creation events are filterable by project", async () => {
    const { innerTx, getCapturedInserts } = makeInnerTxWithCapture();

    const outerTx = {
      ...innerTx,
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnThis(),
          groupBy: jest.fn().mockResolvedValue([
            { projectId: PROJECT_ID, maxNumber: 1 },
          ]),
          orderBy: jest.fn().mockReturnThis(),
          limit: jest.fn().mockResolvedValue([
            { projectId: PROJECT_ID, name: "TODO" },
          ]),
        }),
      }),
      selectDistinctOn: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          limit: jest.fn().mockResolvedValue([
            { projectId: PROJECT_ID, name: "TODO" },
          ]),
        }),
      }),
      transaction: jest.fn().mockImplementation(
        async (cb: (tx: TenantTx) => Promise<unknown>) => cb(innerTx as unknown as TenantTx),
      ),
    } as unknown as TenantTx;

    mockForEachOrg.mockImplementation(
      async (_db, _name, fn) => {
        await fn(
          outerTx,
          ORG_ID,
        );
        return { organizations: 1, succeeded: 1, failed: 0 };
      },
    );

    const outerSelect = outerTx.select as jest.Mock;
    outerSelect.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([TEMPLATE_ROW]),
        }),
      }),
    });

    await service.spawnDueRecurringTickets();

    const inserts = getCapturedInserts();
    const activityInsert = inserts.find((ins) => {
      const vals = ins.valuesArg;
      if (Array.isArray(vals)) {
        return vals.some(
          (row: Record<string, unknown>) => "action" in row && row["action"] === "created",
        );
      }
      return false;
    });

    expect(activityInsert).toBeDefined();
    const activityRows = activityInsert?.valuesArg as Array<Record<string, unknown>>;
    expect(activityRows.every((row) => row["projectId"] === PROJECT_ID)).toBe(true);
  });
});
