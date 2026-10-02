import { Test, type TestingModule } from "@nestjs/testing";
import { BuildAutomationRunnerService } from "./build-automation-runner.service";
import { BuildAutomationActionExecutor } from "./build-automation-actions.service";
import { BuildAutomationRunHistoryService } from "./build-automation-run-history.service";
import { RateLimitService } from "../../../../common/ratelimit/rate-limit.service";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import {
  runWithTenantContext,
  type AfterCommitHook,
  type TenantContext,
} from "../../../../common/tenant/tenant-context";
import type { TenantTx } from "../../../../db/drizzle.types";

jest.mock("../../../../common/logger/logger.service", () => ({
  logger: { warn: jest.fn(), error: jest.fn() },
}));

const noopHistory = { recordRun: jest.fn().mockResolvedValue(null), recordRunActions: jest.fn().mockResolvedValue(undefined) };
const allowAllRateLimiter = { check: jest.fn().mockResolvedValue({ allowed: true, retryAfterSecs: 0 }) };

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

const RULE = {
  id: 1,
  conditions: [],
  actions: [{ type: "set_status", value: "IN_PROGRESS" }],
  createdBy: "user-1",
};

function flush(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 20));
}

describe("BuildAutomationRunnerService — automations are deferred past the request commit", () => {
  let service: BuildAutomationRunnerService;
  let executeFn: jest.Mock;

  const dbSelect = { from: jest.fn().mockReturnThis(), where: jest.fn().mockResolvedValue([RULE]) };
  const mockDb = {
    select: jest.fn().mockReturnValue(dbSelect),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    executeFn = jest.fn().mockResolvedValue(undefined);
    mockDb.select.mockReturnValue(dbSelect);
    dbSelect.from.mockReturnThis();
    dbSelect.where.mockResolvedValue([RULE]);

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

  it("does not query rules or call executor while the request transaction is still open", async () => {
    const afterCommit: AfterCommitHook[] = [];
    const context: TenantContext = {
      orgId: "org-1",
      audience: "INTERNAL",
      tx: {} as TenantTx,
      afterCommit,
    };

    await runWithTenantContext(context, async () => {
      service.runForTicketEvent("org-1", 1, "ticket.created", TICKET);
      await flush();
    });

    expect(mockDb.select).not.toHaveBeenCalled();
    expect(executeFn).not.toHaveBeenCalled();
    expect(afterCommit).toHaveLength(1);
  });

  it("queries rules and calls executor once the registered hook is drained after the commit", async () => {
    const afterCommit: AfterCommitHook[] = [];
    const context: TenantContext = {
      orgId: "org-1",
      audience: "INTERNAL",
      tx: {} as TenantTx,
      afterCommit,
    };

    await runWithTenantContext(context, async () => {
      service.runForTicketEvent("org-1", 1, "ticket.created", TICKET);
      await flush();
    });

    for (const hook of afterCommit) await hook();

    expect(executeFn).toHaveBeenCalledTimes(1);
    expect(executeFn).toHaveBeenCalledWith(
      "org-1",
      1,
      10,
      { type: "set_status", value: "IN_PROGRESS" },
      "user-1",
    );
  });

  it("runs inline when there is no ambient tenant context to defer into", async () => {
    service.runForTicketEvent("org-1", 1, "ticket.created", TICKET);
    await flush();

    expect(executeFn).toHaveBeenCalledTimes(1);
  });
});
