import { Test, type TestingModule } from "@nestjs/testing";
import { BuildAutomationRunnerService } from "./build-automation-runner.service";
import { BuildAutomationActionExecutor } from "./build-automation-actions.service";
import { BuildAutomationRunHistoryService } from "./build-automation-run-history.service";
import { RateLimitService } from "../../../../common/ratelimit/rate-limit.service";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { ProjectsActivityService } from "../activity/projects-activity.service";
import { assertTransitionAllowed } from "../tickets/projects-tickets-workflow-utils";
import { OutboxWriter } from "../../../../common/outbox/outbox-writer";
import {
  runWithTenantContext,
  type AfterCommitHook,
  type TenantContext,
} from "../../../../common/tenant/tenant-context";
import type { TenantTx } from "../../../../db/drizzle.types";

jest.mock("../tickets/projects-tickets-workflow-utils", () => ({
  assertTransitionAllowed: jest.fn(),
}));

jest.mock("../../../../common/outbox/outbox-writer", () => ({
  OutboxWriter: { emit: jest.fn() },
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

  const dbSelect = { from: jest.fn().mockReturnThis(), where: jest.fn().mockResolvedValue([RULE]) };
  const updateReturning = jest.fn().mockResolvedValue([{ version: 2 }]);
  const updateWhere = jest.fn().mockReturnValue({ returning: updateReturning });
  const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
  const mockDb = {
    transaction: jest.fn(),
    execute: jest.fn(),
    select: jest.fn().mockReturnValue(dbSelect),
    update: jest.fn().mockReturnValue({ set: updateSet }),
    insert: jest.fn(),
    query: {
      ticketLabels: { findFirst: jest.fn().mockResolvedValue(null) },
      projectStatuses: { findFirst: jest.fn().mockResolvedValue({ id: 7 }) },
      tickets: { findFirst: jest.fn().mockResolvedValue({ id: 10, status: "TODO", version: 1 }) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.mocked(assertTransitionAllowed).mockResolvedValue(undefined);
    jest.mocked(OutboxWriter.emit).mockResolvedValue(undefined);
    mockDb.transaction.mockImplementation(async (work: (tx: typeof mockDb) => Promise<unknown>) => work(mockDb));
    mockDb.execute.mockResolvedValue([]);
    mockDb.select.mockReturnValue(dbSelect);
    dbSelect.from.mockReturnThis();
    dbSelect.where.mockResolvedValue([RULE]);
    mockDb.update.mockReturnValue({ set: updateSet });
    updateSet.mockReturnValue({ where: updateWhere });
    updateWhere.mockReturnValue({ returning: updateReturning });
    updateReturning.mockResolvedValue([{ version: 2 }]);
    mockDb.query.projectStatuses.findFirst.mockResolvedValue({ id: 7 });
    mockDb.query.tickets.findFirst.mockResolvedValue({ id: 10, status: "TODO", version: 1 });
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

  it("does not touch the database while the request transaction is still open", async () => {
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
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(afterCommit).toHaveLength(1);
  });

  it("applies the rule once the registered hook is drained after the commit", async () => {
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

    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ status: "IN_PROGRESS" }));
  });

  it("runs inline when there is no ambient context to defer into", async () => {
    service.runForTicketEvent("org-1", 1, "ticket.created", TICKET);
    await flush();

    expect(mockDb.update).toHaveBeenCalledTimes(1);
  });
});
