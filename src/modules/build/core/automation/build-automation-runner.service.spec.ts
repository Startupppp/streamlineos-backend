import { Test, type TestingModule } from "@nestjs/testing";
import { BuildAutomationRunnerService } from "./build-automation-runner.service";
import { BuildAutomationActionExecutor } from "./build-automation-actions.service";
import { BuildAutomationRunHistoryService } from "./build-automation-run-history.service";
import { RateLimitService } from "../../../../common/ratelimit/rate-limit.service";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { ProjectsActivityService } from "../activity/projects-activity.service";
import { assertTransitionAllowed } from "../tickets/projects-tickets-workflow-utils";
import { OutboxWriter } from "../../../../common/outbox/outbox-writer";
import { logger } from "../../../../common/logger/logger.service";

jest.mock("../tickets/projects-tickets-workflow-utils", () => ({
  assertTransitionAllowed: jest.fn(),
}));

jest.mock("../../../../common/outbox/outbox-writer", () => ({
  OutboxWriter: { emit: jest.fn() },
}));

const noopHistory = { recordRun: jest.fn().mockResolvedValue(null), recordRunActions: jest.fn().mockResolvedValue(undefined) };
const allowAllRateLimiter = { check: jest.fn().mockResolvedValue({ allowed: true, retryAfterSecs: 0 }) };

jest.mock("../../../../common/logger/logger.service", () => ({
  logger: { warn: jest.fn(), error: jest.fn() },
}));

function makeRule(
  overrides: Partial<{
    id: number;
    conditions: unknown[];
    actions: unknown[];
    createdBy: string | null;
  }> = {},
) {
  return {
    id: 1,
    conditions: [],
    actions: [{ type: "set_status", value: "IN_PROGRESS" }],
    createdBy: "user-1",
    ...overrides,
  };
}

const BASE_TICKET = {
  ticketId: 10,
  projectId: 1,
  orgId: "org-1",
  status: "TODO",
  priority: "MEDIUM",
  assigneeId: null,
  title: "Fix bug",
  type: "TASK",
};

describe("BuildAutomationRunnerService", () => {
  let service: BuildAutomationRunnerService;

  const dbSelect = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue([]),
  };

  const dbInsert = {
    values: jest.fn().mockReturnThis(),
    onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
  };

  const mockSetFn = jest.fn().mockReturnThis();
  const mockReturningFn = jest.fn().mockResolvedValue([{ version: 2 }]);
  const mockWhereFn = jest.fn().mockReturnValue({ returning: mockReturningFn });
  const mockUpdateChain = { set: mockSetFn, where: mockWhereFn };

  const mockDb = {
    transaction: jest.fn(),
    execute: jest.fn(),
    select: jest.fn().mockReturnValue(dbSelect),
    update: jest.fn().mockReturnValue(mockUpdateChain),
    insert: jest.fn().mockReturnValue(dbInsert),
    query: {
      ticketLabels: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      projectStatuses: {
        findFirst: jest.fn().mockResolvedValue({ id: 7 }),
      },
      tickets: {
        findFirst: jest.fn().mockResolvedValue({ id: 10, status: "TODO", version: 1 }),
      },
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.transaction.mockImplementation(async (work: (tx: typeof mockDb) => Promise<unknown>) => work(mockDb));
    mockDb.execute.mockResolvedValue([]);
    mockDb.select.mockReturnValue(dbSelect);
    dbSelect.from.mockReturnThis();
    dbSelect.where.mockResolvedValue([]);
    jest.mocked(assertTransitionAllowed).mockResolvedValue(undefined);
    jest.mocked(OutboxWriter.emit).mockResolvedValue(undefined);
    mockDb.update.mockReturnValue(mockUpdateChain);
    mockSetFn.mockReturnThis();
    mockReturningFn.mockResolvedValue([{ version: 2 }]);
    mockWhereFn.mockReturnValue({ returning: mockReturningFn });
    mockDb.insert.mockReturnValue(dbInsert);
    mockDb.query.tickets.findFirst.mockResolvedValue({ id: 10, status: "TODO", version: 1 });
    dbInsert.values.mockReturnThis();
    dbInsert.onConflictDoNothing.mockResolvedValue(undefined);
    mockDb.query.ticketLabels.findFirst.mockResolvedValue(null);
    mockDb.query.projectStatuses.findFirst.mockResolvedValue({ id: 7 });
    mockDb.query.organizationMembers.findFirst.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BuildAutomationRunnerService,
        BuildAutomationActionExecutor,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: BuildAutomationRunHistoryService, useValue: noopHistory },
        { provide: RateLimitService, useValue: allowAllRateLimiter },
        { provide: ProjectsActivityService, useValue: { logTicketActivity: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    service = module.get(BuildAutomationRunnerService);
  });

  function flush(): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, 20));
  }

  it("fires set_status action when the status exists in the project", async () => {
    mockDb.query.projectStatuses.findFirst.mockResolvedValue({ id: 7 });
    dbSelect.where.mockResolvedValue([makeRule()]);

    service.runForTicketEvent("org-1", 1, "ticket.created", BASE_TICKET);
    await flush();

    expect(mockDb.update).toHaveBeenCalled();
    expect(mockSetFn).toHaveBeenCalledWith(expect.objectContaining({ status: "IN_PROGRESS" }));
  });

  it("leaves the ticket unchanged when an automation targets a full column", async () => {
    dbSelect.where.mockResolvedValue([makeRule()]);
    mockDb.execute.mockResolvedValue([{ name: "IN_PROGRESS", wip_limit: 1, current_count: 1 }]);
    service.runForTicketEvent("org-1", 1, "ticket.created", BASE_TICKET);
    await flush();
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith("BuildAutomationRunner: action failed", expect.objectContaining({ actionType: "set_status" }));
  });

  it("skips set_status and logs a warning when the status does not exist in the project", async () => {
    mockDb.query.projectStatuses.findFirst.mockResolvedValue(undefined);
    dbSelect.where.mockResolvedValue([makeRule()]);

    service.runForTicketEvent("org-1", 1, "ticket.created", BASE_TICKET);
    await flush();

    expect(mockDb.update).not.toHaveBeenCalled();
    // Log prefix moved with the code: action execution now lives in
    // BuildAutomationActionExecutor (split out of BuildAutomationRunnerService, BE-09).
    expect(logger.warn).toHaveBeenCalledWith(
      "BuildAutomationActionExecutor: set_status skipped — status does not exist in project",
      expect.objectContaining({ ruleId: 1, projectId: 1, orgId: "org-1", status: "IN_PROGRESS" }),
    );
  });

  it("does not throw when the target status is absent — the hook must not abort the transaction", async () => {
    mockDb.query.projectStatuses.findFirst.mockResolvedValue(undefined);
    dbSelect.where.mockResolvedValue([makeRule()]);

    await expect(
      service["execute"]("org-1", 1, "ticket.created", BASE_TICKET),
    ).resolves.toBeUndefined();
  });

  it("does not fire when the rule condition does not match the ticket payload", async () => {
    dbSelect.where.mockResolvedValue([
      makeRule({
        conditions: [{ field: "priority", operator: "equals", value: "URGENT" }],
        actions: [{ type: "set_status", value: "DONE" }],
      }),
    ]);

    service.runForTicketEvent("org-1", 1, "ticket.created", { ...BASE_TICKET, priority: "LOW" });
    await flush();

    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("does not fire when the DB returns no active rules (inactive rule scenario)", async () => {
    dbSelect.where.mockResolvedValue([]);

    service.runForTicketEvent("org-1", 1, "ticket.created", BASE_TICKET);
    await flush();

    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("enforces cross-tenant isolation: org-a rules never execute for org-b requests", async () => {
    dbSelect.where.mockResolvedValueOnce([makeRule()]);
    service.runForTicketEvent("org-a", 1, "ticket.created", { ...BASE_TICKET, orgId: "org-a" });
    await flush();
    const callsAfterOrgA = mockDb.update.mock.calls.length;

    dbSelect.where.mockResolvedValueOnce([]);
    service.runForTicketEvent("org-b", 1, "ticket.created", { ...BASE_TICKET, orgId: "org-b" });
    await flush();

    expect(callsAfterOrgA).toBe(1);
    expect(mockDb.update.mock.calls.length).toBe(1);
  });

  it("continues processing subsequent actions when one action throws", async () => {
    mockReturningFn
      .mockRejectedValueOnce(new Error("DB transient error"))
      .mockResolvedValue([{ version: 2 }]);

    dbSelect.where.mockResolvedValue([
      makeRule({
        actions: [
          { type: "set_status", value: "IN_PROGRESS" },
          { type: "set_status", value: "DONE" },
        ],
      }),
    ]);

    service.runForTicketEvent("org-1", 1, "ticket.created", BASE_TICKET);
    await flush();

    expect(mockSetFn).toHaveBeenCalledTimes(2);
  });
});
