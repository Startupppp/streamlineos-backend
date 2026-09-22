process.env.APP_URL ??= "http://localhost:1000";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(
    async (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn({}),
  ),
}));

import {
  runWithTenantContext,
  type AfterCommitHook,
  type TenantContext,
} from "../../../common/tenant/tenant-context";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { logger } from "../../../common/logger/logger.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { LeavesWriteService } from "./leaves-write.service";
import { OvertimeService } from "./overtime.service";

/**
 * Neither leave nor overtime approval is driven by the workflow engine — both
 * are decided by a direct status flip on the request row — so a failed
 * `startWorkflow` does not strand the request. What it does cost is the whole
 * workflow console: the instance inbox, the timeline and the SLA escalation
 * sweep all read `hr_workflow_instances`, and nothing in the repository ever
 * creates a missing one. `startWorkflow` also does not throw when no definition
 * is configured — it inserts a synthetic auto-approved instance — so every
 * failure the old bare `catch {}` could swallow was a real one, logged nowhere.
 *
 * The overtime site additionally fired the call as a bare `void` inside the
 * request, which leaves it running on a transaction that has already committed
 * and a tenant GUC that is gone.
 */

const USER: CurrentUserContext = {
  userId: "employee-1",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

const runInNew = runInNewTenantTransaction as jest.MockedFunction<
  typeof runInNewTenantTransaction
>;

function warnings(spy: jest.SpyInstance): string[] {
  return spy.mock.calls.map((call) => String(call[0]));
}

function selectChain(rows: unknown[]) {
  const chain = { from: jest.fn(), where: jest.fn(), limit: jest.fn().mockResolvedValue(rows) };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  return chain;
}

function balanceSelect() {
  const chain = {
    from: jest.fn(),
    where: jest.fn(),
    for: jest.fn(),
    limit: jest.fn().mockResolvedValue([{ balance: "10.00" }]),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.for.mockReturnValue(chain);
  return chain;
}

function tenantContext(afterCommit: AfterCommitHook[], tx: unknown): TenantContext {
  return { orgId: USER.orgId, audience: "INTERNAL", tx, afterCommit } as TenantContext;
}

describe("OvertimeService — the approval workflow is started after commit, and its failure is visible", () => {
  let warn: jest.SpyInstance;

  function build(startWorkflow: jest.Mock) {
    const db = {
      query: { overtimeRequests: { findFirst: jest.fn().mockResolvedValue(undefined) } },
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 77 }]) }),
      }),
      select: jest
        .fn()
        .mockReturnValue(
          selectChain([
            { id: 9, orgId: "org-1", userId: "employee-1", role: "MEMBER", isOwner: false, status: "ACTIVE" },
          ]),
        ),
    };
    const service = new OvertimeService(db as never, null as never, { startWorkflow } as never);
    return { db, service };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it("defers the workflow start to an after-commit hook in its own tenant transaction", async () => {
    const startWorkflow = jest.fn().mockResolvedValue(undefined);
    const { service } = build(startWorkflow);
    const afterCommit: AfterCommitHook[] = [];

    await runWithTenantContext(tenantContext(afterCommit, {}), () =>
      service.createRequest("org-1", "employee-1", { date: "2026-08-12", hours: "2.00" }),
    );

    expect(startWorkflow).not.toHaveBeenCalled();
    expect(runInNew).not.toHaveBeenCalled();
    expect(afterCommit).toHaveLength(1);

    await afterCommit[0]?.();

    expect(runInNew).toHaveBeenCalledWith(expect.anything(), "org-1", expect.any(Function));
    expect(startWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", objectType: "overtime_request", objectId: "77" }),
    );
  });

  it("logs the failure instead of dropping it when the workflow start rejects", async () => {
    const startWorkflow = jest.fn().mockRejectedValue(new Error("permission denied for table"));
    const { service } = build(startWorkflow);
    const afterCommit: AfterCommitHook[] = [];

    await runWithTenantContext(tenantContext(afterCommit, {}), () =>
      service.createRequest("org-1", "employee-1", { date: "2026-08-13", hours: "3.00" }),
    );
    await expect(afterCommit[0]?.()).resolves.toBeUndefined();

    expect(warnings(warn)).toContain("overtime approval workflow start failed");
  });
});

describe("LeavesWriteService — the deferred leave side effects are visible when they fail", () => {
  let warn: jest.SpyInstance;

  function build(overrides: { startWorkflow?: jest.Mock; emit?: jest.Mock }) {
    const insertedValues = jest
      .fn()
      .mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 42 }]) });
    const tx = {
      execute: jest.fn().mockResolvedValue([]),
      select: jest.fn().mockReturnValue(balanceSelect()),
      query: {
        leaveTypes: {
          findFirst: jest.fn().mockResolvedValue({ name: "Annual Leave", daysPerYear: 20 }),
        },
        leaveRequests: { findFirst: jest.fn().mockResolvedValue(undefined) },
        leaveBlackoutDates: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      insert: jest.fn().mockReturnValue({ values: insertedValues }),
    };
    const db = {
      query: { users: { findFirst: jest.fn().mockResolvedValue({ name: "Employee One" }) } },
      select: jest
        .fn()
        .mockReturnValueOnce(selectChain([{ id: 1, orgId: "org-1", userId: "employee-1", role: "MEMBER", isOwner: false, status: "ACTIVE" }]))
        .mockReturnValueOnce(selectChain([]))
        .mockReturnValueOnce(selectChain([{ probationRestricted: false }])),
      transaction: jest.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    const startWorkflow = overrides.startWorkflow ?? jest.fn().mockResolvedValue(undefined);
    const emit = overrides.emit ?? jest.fn().mockResolvedValue(undefined);
    const service = new LeavesWriteService(
      db as never,
      { logCritical: jest.fn() } as never,
      { emit } as never,
      { runAutomationsForEvent: jest.fn().mockResolvedValue(undefined) } as never,
      { startWorkflow } as never,
      {
        invalidateNamespace: jest.fn().mockResolvedValue(undefined),
        invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
      } as never,
      { membersWithPermission: jest.fn().mockResolvedValue([{ userId: "manager-1" }]) } as never,
      { resolve: jest.fn().mockResolvedValue({
        rung: "reporting_manager",
        approver: { userId: "manager-1", membershipId: 5, name: "Manager", email: "manager@example.com", designation: null },
        queue: null,
        delegation: null,
        escalation: null,
        dueAt: "2026-08-14T00:00:00.000Z",
        explanation: "Manager approves as reporting manager.",
      }) } as never,
      { probationCoverageOn: jest.fn().mockResolvedValue("past-probation") } as never,
      {
        getFacts: jest.fn().mockResolvedValue({ managerUserId: null }),
        getDirectReportUserIds: jest.fn().mockResolvedValue([]),
      } as never,
    );
    return { service, tx, startWorkflow, emit };
  }

  async function submit(service: LeavesWriteService, tx: unknown): Promise<AfterCommitHook[]> {
    const afterCommit: AfterCommitHook[] = [];
    await runWithTenantContext(tenantContext(afterCommit, tx), () =>
      service.create(USER, {
        leaveTypeId: 1,
        startDate: "2026-08-12",
        endDate: "2026-08-12",
        reason: "Medical appointment",
        priority: "MEDIUM",
        isHalfDay: false,
      }),
    );
    return afterCommit;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it("logs a failed workflow start and still dispatches the request notification", async () => {
    const startWorkflow = jest.fn().mockRejectedValue(new Error("permission denied for table"));
    const { service, tx, emit } = build({ startWorkflow });

    const afterCommit = await submit(service, tx);
    await expect(afterCommit[0]?.()).resolves.toBeUndefined();

    expect(warnings(warn)).toContain("leave approval workflow start failed");
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ eventKey: "hr.leave.requested" }));
  });

  it("logs a failed request notification rather than returning from an empty catch", async () => {
    const emit = jest.fn().mockRejectedValue(new Error("notification dispatch unavailable"));
    const { service, tx } = build({ emit });

    const afterCommit = await submit(service, tx);
    await expect(afterCommit[0]?.()).resolves.toBeUndefined();

    expect(warnings(warn)).toContain("leave requested notification failed");
  });
});
