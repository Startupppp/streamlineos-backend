import { ConflictException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { BuildAutomationRunnerService } from "./build-automation-runner.service";
import { BuildAutomationActionExecutor } from "./build-automation-actions.service";
import { BuildAutomationRunHistoryService } from "./build-automation-run-history.service";
import { RateLimitService } from "../../../../common/ratelimit/rate-limit.service";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { logger } from "../../../../common/logger/logger.service";

jest.mock("../../../../common/logger/logger.service", () => ({
  logger: { warn: jest.fn(), error: jest.fn() },
}));

const noopHistory = { recordRun: jest.fn().mockResolvedValue(null), recordRunActions: jest.fn().mockResolvedValue(undefined) };
const allowAllRateLimiter = { check: jest.fn().mockResolvedValue({ allowed: true, retryAfterSecs: 0 }) };

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
  let executeFn: jest.Mock;

  const dbSelect = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue([]),
  };

  const mockDb = {
    select: jest.fn().mockReturnValue(dbSelect),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    executeFn = jest.fn().mockResolvedValue(undefined);
    mockDb.select.mockReturnValue(dbSelect);
    dbSelect.from.mockReturnThis();
    dbSelect.where.mockResolvedValue([]);
    noopHistory.recordRun.mockResolvedValue(null);
    noopHistory.recordRunActions.mockResolvedValue(undefined);
    allowAllRateLimiter.check.mockResolvedValue({ allowed: true, retryAfterSecs: 0 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BuildAutomationRunnerService,
        { provide: BuildAutomationActionExecutor, useValue: { execute: executeFn } },
        { provide: DRIZZLE, useValue: mockDb },
        { provide: BuildAutomationRunHistoryService, useValue: noopHistory },
        { provide: RateLimitService, useValue: allowAllRateLimiter },
      ],
    }).compile();

    service = module.get(BuildAutomationRunnerService);
  });

  function flush(): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, 20));
  }

  it("calls executor.execute for a matched rule with the correct args", async () => {
    dbSelect.where.mockResolvedValue([makeRule()]);

    service.runForTicketEvent("org-1", 1, "ticket.created", BASE_TICKET);
    await flush();

    expect(executeFn).toHaveBeenCalledWith("org-1", 1, 10, { type: "set_status", value: "IN_PROGRESS" }, "user-1");
  });

  it("records action as failure and logs error when executor throws, then continues processing remaining actions", async () => {
    executeFn
      .mockRejectedValueOnce(new ConflictException("WIP limit exceeded"))
      .mockResolvedValue(undefined);

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

    expect(executeFn).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      "BuildAutomationRunner: action failed",
      expect.objectContaining({ actionType: "set_status" }),
    );
  });

  it("execute resolves without rethrowing even when all actions fail", async () => {
    executeFn.mockRejectedValue(new Error("any failure"));
    dbSelect.where.mockResolvedValue([makeRule()]);

    await expect(
      service["execute"]("org-1", 1, "ticket.created", BASE_TICKET),
    ).resolves.toBeUndefined();
  });

  it("does not call executor.execute when the rule condition does not match the ticket payload", async () => {
    dbSelect.where.mockResolvedValue([
      makeRule({
        conditions: [{ field: "priority", operator: "equals", value: "URGENT" }],
        actions: [{ type: "set_status", value: "DONE" }],
      }),
    ]);

    service.runForTicketEvent("org-1", 1, "ticket.created", { ...BASE_TICKET, priority: "LOW" });
    await flush();

    expect(executeFn).not.toHaveBeenCalled();
  });

  it("does not call executor.execute when the DB returns no active rules", async () => {
    dbSelect.where.mockResolvedValue([]);

    service.runForTicketEvent("org-1", 1, "ticket.created", BASE_TICKET);
    await flush();

    expect(executeFn).not.toHaveBeenCalled();
  });

  it("enforces cross-tenant isolation: org-a rules never execute for org-b events", async () => {
    dbSelect.where.mockResolvedValueOnce([makeRule()]);
    service.runForTicketEvent("org-a", 1, "ticket.created", { ...BASE_TICKET, orgId: "org-a" });
    await flush();
    const callsAfterOrgA = executeFn.mock.calls.length;

    dbSelect.where.mockResolvedValueOnce([]);
    service.runForTicketEvent("org-b", 1, "ticket.created", { ...BASE_TICKET, orgId: "org-b" });
    await flush();

    expect(callsAfterOrgA).toBe(1);
    expect(executeFn.mock.calls.length).toBe(1);
  });

  it("calls executor.execute for each action in a multi-action rule that all succeed", async () => {
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

    expect(executeFn).toHaveBeenCalledTimes(2);
  });
});
