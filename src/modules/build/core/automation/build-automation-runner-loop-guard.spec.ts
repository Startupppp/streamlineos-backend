import { Test, type TestingModule } from "@nestjs/testing";
import { BuildAutomationRunnerService } from "./build-automation-runner.service";
import { BuildAutomationActionExecutor } from "./build-automation-actions.service";
import { BuildAutomationRunHistoryService } from "./build-automation-run-history.service";
import { RateLimitService } from "../../../../common/ratelimit/rate-limit.service";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import {
  runWithTenantContext,
  type AfterCommitHook,
  type TenantContext,
} from "../../../../common/tenant/tenant-context";
import type { TenantTx } from "../../../../db/drizzle.types";

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

const RULE = {
  id: 1,
  conditions: [],
  actions: [{ type: "set_status", value: "IN_PROGRESS" }],
  createdBy: "user-1",
};

function flush(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 20));
}

describe("BuildAutomationRunnerService — loop-prevention guard", () => {
  const dbSelect = { from: jest.fn().mockReturnThis(), where: jest.fn().mockResolvedValue([RULE]) };
  const mockDb = {
    select: jest.fn().mockReturnValue(dbSelect),
  } as unknown as Db;

  const recordRun = jest.fn().mockResolvedValue(null);
  const recordRunActions = jest.fn().mockResolvedValue(undefined);
  const allowAllRateLimiter = { check: jest.fn().mockResolvedValue({ allowed: true, retryAfterSecs: 0 }) };

  beforeEach(() => {
    jest.clearAllMocks();
    (mockDb.select as jest.Mock).mockReturnValue(dbSelect);
    dbSelect.from.mockReturnThis();
    dbSelect.where.mockResolvedValue([RULE]);
    recordRun.mockResolvedValue(null);
    allowAllRateLimiter.check.mockResolvedValue({ allowed: true, retryAfterSecs: 0 });
  });

  async function buildService(actionExecutor: { execute: jest.Mock }): Promise<BuildAutomationRunnerService> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BuildAutomationRunnerService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: BuildAutomationActionExecutor, useValue: actionExecutor },
        { provide: BuildAutomationRunHistoryService, useValue: { recordRun, recordRunActions } },
        { provide: RateLimitService, useValue: allowAllRateLimiter },
      ],
    }).compile();
    return module.get(BuildAutomationRunnerService);
  }

  it("blocks a rule whose own action re-triggers the same ticket+event, and records why", async () => {
    let reentered = false;
    let service!: BuildAutomationRunnerService;
    const actionExecutor = {
      execute: jest.fn().mockImplementation(async () => {
        if (!reentered) {
          reentered = true;
          service.runForTicketEvent("org-1", 1, "ticket.created", TICKET);
        }
      }),
    };
    service = await buildService(actionExecutor);

    service.runForTicketEvent("org-1", 1, "ticket.created", TICKET);
    await flush();

    expect(dbSelect.where).toHaveBeenCalledTimes(1);

    const blocked = recordRun.mock.calls.find((c) => (c[0] as { outcome: string }).outcome === "blocked_loop_guard");
    expect(blocked).toBeDefined();
    expect(blocked?.[0]).toMatchObject({
      orgId: "org-1",
      projectId: 1,
      automationId: null,
      ticketId: 10,
      triggerEvent: "ticket.created",
      matched: false,
      outcome: "blocked_loop_guard",
    });
  });

  it("does not block two independent (non-nested) triggers for the same ticket+event", async () => {
    const actionExecutor = { execute: jest.fn().mockResolvedValue(undefined) };
    const service = await buildService(actionExecutor);

    service.runForTicketEvent("org-1", 1, "ticket.created", TICKET);
    await flush();
    service.runForTicketEvent("org-1", 1, "ticket.created", TICKET);
    await flush();

    expect(dbSelect.where).toHaveBeenCalledTimes(2);
    expect(recordRun.mock.calls.some((c) => (c[0] as { outcome: string }).outcome === "blocked_loop_guard")).toBe(false);
  });

  it("blocks once the chain depth reaches the ceiling, even across distinct trigger events", async () => {
    let service!: BuildAutomationRunnerService;
    const events = ["ticket.created", "ticket.updated", "ticket.assigned", "ticket.status_changed", "ticket.created"];
    let hop = 0;
    const actionExecutor = {
      execute: jest.fn().mockImplementation(async () => {
        hop += 1;
        if (hop < events.length) service.runForTicketEvent("org-1", 1, events[hop], TICKET);
      }),
    };
    service = await buildService(actionExecutor);

    service.runForTicketEvent("org-1", 1, events[0], TICKET);
    await flush();

    const blocked = recordRun.mock.calls.filter((c) => (c[0] as { outcome: string }).outcome === "blocked_loop_guard");
    expect(blocked.length).toBeGreaterThan(0);
    expect(dbSelect.where.mock.calls.length).toBeLessThan(events.length);
  });

  it("loop guard holds when the re-entrant trigger is deferred via registerAfterCommit", async () => {
    let service!: BuildAutomationRunnerService;
    const actionExecutor = {
      execute: jest.fn().mockImplementation(async () => {
        service.runForTicketEvent("org-1", 1, "ticket.created", TICKET);
      }),
    };
    service = await buildService(actionExecutor);

    const afterCommit: AfterCommitHook[] = [];
    const context: TenantContext = {
      orgId: "org-1",
      audience: "INTERNAL",
      tx: {} as TenantTx,
      afterCommit,
    };

    await runWithTenantContext(context, async () => {
      service.runForTicketEvent("org-1", 1, "ticket.created", TICKET);
    });

    expect(dbSelect.where).not.toHaveBeenCalled();
    expect(afterCommit).toHaveLength(1);

    for (const hook of afterCommit) await hook();
    await flush();

    expect(dbSelect.where).toHaveBeenCalledTimes(1);
    const blocked = recordRun.mock.calls.find(
      (c) => (c[0] as { outcome: string }).outcome === "blocked_loop_guard",
    );
    expect(blocked).toBeDefined();
  });
});
