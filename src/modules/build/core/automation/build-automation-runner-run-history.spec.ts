import { Test, type TestingModule } from "@nestjs/testing";
import { BuildAutomationRunnerService } from "./build-automation-runner.service";
import { BuildAutomationActionExecutor } from "./build-automation-actions.service";
import { BuildAutomationRunHistoryService } from "./build-automation-run-history.service";
import { AccessService } from "../../../access/access.service";
import { RateLimitService } from "../../../../common/ratelimit/rate-limit.service";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";

jest.mock("../../../../common/logger/logger.service", () => ({
  logger: { warn: jest.fn(), error: jest.fn() },
}));

const TICKET = {
  ticketId: 10,
  projectId: 1,
  orgId: "org-1",
  status: "TODO",
  priority: "MEDIUM",
  assigneeId: null,
  title: "Fix bug",
  type: "TASK",
};

function makeRule(overrides: Partial<{ id: number; conditions: unknown[]; actions: unknown[]; createdBy: string | null }> = {}) {
  return {
    id: 1,
    conditions: [],
    actions: [{ type: "set_status", value: "IN_PROGRESS" }],
    createdBy: "user-1",
    ...overrides,
  };
}

function flush(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 20));
}

/**
 * These tests exercise `BuildAutomationRunnerService` wired to the REAL
 * `BuildAutomationRunHistoryService` (only its `DRIZZLE` and
 * `ProjectsMembersService` dependencies are mocked), so what's asserted is
 * exactly what `db.insert(projectAutomationRuns)`/`projectAutomationRunActions`
 * were called with — the actual persistence shape, not a stubbed call.
 */
describe("BuildAutomationRunnerService — durable run history", () => {
  let service: BuildAutomationRunnerService;
  let insertedRuns: Record<string, unknown>[];
  let insertedActions: Record<string, unknown>[];
  let nextRunId: number;

  const dbSelect = { from: jest.fn().mockReturnThis(), where: jest.fn().mockResolvedValue([]) };
  const updateWhere = jest.fn().mockResolvedValue(undefined);
  const updateSet = jest.fn().mockReturnValue({ where: updateWhere });

  const mockDb = {
    transaction: jest.fn(),
    execute: jest.fn(),
    select: jest.fn(),
    update: jest.fn(),
    insert: jest.fn(),
    query: {
      ticketLabels: { findFirst: jest.fn().mockResolvedValue(null) },
      projectStatuses: { findFirst: jest.fn().mockResolvedValue({ id: 7 }) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
    },
  } as unknown as Db;

  beforeEach(async () => {
    jest.clearAllMocks();
    insertedRuns = [];
    insertedActions = [];
    nextRunId = 100;

    (mockDb.transaction as jest.Mock).mockImplementation(async (work: (tx: typeof mockDb) => Promise<unknown>) => work(mockDb));
    (mockDb.execute as jest.Mock).mockResolvedValue([]);
    (mockDb.select as jest.Mock).mockReturnValue(dbSelect);
    dbSelect.from.mockReturnThis();
    dbSelect.where.mockResolvedValue([]);
    (mockDb.update as jest.Mock).mockReturnValue({ set: updateSet });
    updateSet.mockReturnValue({ where: updateWhere });
    updateWhere.mockResolvedValue(undefined);
    (mockDb.query.projectStatuses.findFirst as jest.Mock).mockResolvedValue({ id: 7 });
    (mockDb.query.organizationMembers.findFirst as jest.Mock).mockResolvedValue(null);

    // Routes by shape: a run-action row carries `runId`, a run row does not.
    (mockDb.insert as jest.Mock).mockImplementation(() => ({
      values: (values: Record<string, unknown> | Record<string, unknown>[]) => {
        const rows = Array.isArray(values) ? values : [values];
        if (rows.length > 0 && "runId" in rows[0]) {
          insertedActions.push(...rows);
          return Promise.resolve([]);
        }
        insertedRuns.push(...rows);
        const id = nextRunId++;
        return { returning: jest.fn().mockResolvedValue([{ id }]) };
      },
      onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
    }));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BuildAutomationRunnerService,
        BuildAutomationActionExecutor,
        BuildAutomationRunHistoryService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AccessService, useValue: {} },
        { provide: RateLimitService, useValue: { check: jest.fn().mockResolvedValue({ allowed: true, retryAfterSecs: 0 }) } },
      ],
    }).compile();

    service = module.get(BuildAutomationRunnerService);
  });

  it("records a matched_success run and a success action row when the rule matches and the action succeeds", async () => {
    dbSelect.where.mockResolvedValue([makeRule()]);

    service.runForTicketEvent("org-1", 1, "ticket.created", TICKET);
    await flush();

    expect(insertedRuns).toHaveLength(1);
    expect(insertedRuns[0]).toMatchObject({
      orgId: "org-1",
      projectId: 1,
      automationId: 1,
      ticketId: 10,
      triggerEvent: "ticket.created",
      matched: true,
      outcome: "matched_success",
      errorMessage: null,
    });
    expect(insertedActions).toHaveLength(1);
    expect(insertedActions[0]).toMatchObject({
      actionIndex: 0,
      actionType: "set_status",
      outcome: "success",
      errorMessage: null,
    });
  });

  it("records a matched_failed run and a failure action row when the only action throws", async () => {
    updateWhere.mockRejectedValueOnce(new Error("boom"));
    dbSelect.where.mockResolvedValue([makeRule()]);

    service.runForTicketEvent("org-1", 1, "ticket.created", TICKET);
    await flush();

    expect(insertedRuns).toHaveLength(1);
    expect(insertedRuns[0]).toMatchObject({ matched: true, outcome: "matched_failed" });
    expect(insertedActions).toHaveLength(1);
    expect(insertedActions[0]).toMatchObject({ outcome: "failure", errorMessage: "boom" });
  });

  it("records matched_partial_failure when some actions succeed and some fail", async () => {
    updateWhere.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("second action failed"));
    dbSelect.where.mockResolvedValue([
      makeRule({ actions: [{ type: "set_status", value: "IN_PROGRESS" }, { type: "set_status", value: "DONE" }] }),
    ]);

    service.runForTicketEvent("org-1", 1, "ticket.created", TICKET);
    await flush();

    expect(insertedRuns[0]).toMatchObject({ outcome: "matched_partial_failure" });
    expect(insertedActions).toHaveLength(2);
    expect(insertedActions[0]).toMatchObject({ actionIndex: 0, outcome: "success" });
    expect(insertedActions[1]).toMatchObject({ actionIndex: 1, outcome: "failure", errorMessage: "second action failed" });
  });

  it("records a not_matched run and no action rows when the rule's conditions do not match", async () => {
    dbSelect.where.mockResolvedValue([
      makeRule({ conditions: [{ field: "priority", operator: "equals", value: "URGENT" }] }),
    ]);

    service.runForTicketEvent("org-1", 1, "ticket.created", { ...TICKET, priority: "LOW" });
    await flush();

    expect(insertedRuns).toHaveLength(1);
    expect(insertedRuns[0]).toMatchObject({ matched: false, outcome: "not_matched" });
    expect(insertedActions).toHaveLength(0);
  });

  it("records nothing when there are no active rules for the trigger event", async () => {
    dbSelect.where.mockResolvedValue([]);

    service.runForTicketEvent("org-1", 1, "ticket.created", TICKET);
    await flush();

    expect(insertedRuns).toHaveLength(0);
  });
});
