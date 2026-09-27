import { Test, type TestingModule } from "@nestjs/testing";
import { BuildAutomationRunnerService } from "./build-automation-runner.service";
import { BuildAutomationActionExecutor } from "./build-automation-actions.service";
import { BuildAutomationRunHistoryService } from "./build-automation-run-history.service";
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

const RULE = {
  id: 1,
  conditions: [],
  actions: [{ type: "set_status", value: "IN_PROGRESS" }],
  createdBy: "user-1",
};

function flush(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 20));
}

/**
 * Today `BuildAutomationActionExecutor`'s writes never call back into
 * `runForTicketEvent` (see the loop-prevention note on
 * `BuildAutomationRunnerService`) — verified by grep, not by this test. What
 * this test proves is that IF an action ever did re-trigger the runner (a
 * plausible future refactor the brief asks to defend against), the guard
 * stops it rather than recursing unbounded. `BuildAutomationActionExecutor`
 * is replaced with a stub whose "action" is exactly that re-entrant call.
 */
describe("BuildAutomationRunnerService — loop-prevention guard", () => {
  const dbSelect = { from: jest.fn().mockReturnThis(), where: jest.fn().mockResolvedValue([RULE]) };
  const mockDb = {
    select: jest.fn().mockReturnValue(dbSelect),
    query: {
      ticketLabels: { findFirst: jest.fn().mockResolvedValue(null) },
      projectStatuses: { findFirst: jest.fn().mockResolvedValue({ id: 7 }) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
    },
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

    // The rules query only ever runs for the outer call — the re-entrant
    // inner call is blocked before it reaches rule evaluation at all.
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
    const events = ["ticket.created", "ticket.updated", "ticket.assigned", "ticket.status_changed", "sprint.started"];
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
    // The chain never got anywhere near the full 5-event list before the depth ceiling cut it off.
    expect(dbSelect.where.mock.calls.length).toBeLessThan(events.length);
  });
});
