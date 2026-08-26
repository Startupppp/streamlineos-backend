process.env.APP_URL ??= "http://localhost:1000";

import {
  runWithTenantContext,
  type AfterCommitHook,
  type TenantContext,
} from "../../../common/tenant/tenant-context";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { createLeaveSchema } from "./dto/leaves.schemas";
import { LeavesWriteService } from "./leaves-write.service";

const USER: CurrentUserContext = {
  userId: "employee-1",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
};

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

describe("LeavesWriteService server-derived approver", () => {
  it("rejects a client-supplied approver field", () => {
    expect(
      createLeaveSchema.safeParse({
        leaveTypeId: 1,
        startDate: "2026-08-12",
        endDate: "2026-08-12",
        reason: "Medical appointment",
        approverId: "attacker-chosen-user",
      }).success,
    ).toBe(false);
  });

  it("persists only the approver resolved by the server and defers side effects", async () => {
    const insertedValues = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: 42 }]),
    });
    const tx = {
      execute: jest.fn().mockResolvedValue([]),
      select: jest.fn().mockReturnValue(balanceSelect()),
      query: {
        leaveTypes: {
          findFirst: jest.fn().mockResolvedValue({
            name: "Annual Leave",
            daysPerYear: 20,
          }),
        },
        leaveRequests: { findFirst: jest.fn().mockResolvedValue(undefined) },
        leaveBlackoutDates: {
          findFirst: jest.fn().mockResolvedValue(undefined),
        },
      },
      insert: jest.fn().mockReturnValue({ values: insertedValues }),
    };
    const db = {
      query: {
        users: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      transaction: jest.fn(
        async (callback: (transaction: typeof tx) => Promise<unknown>) =>
          callback(tx),
      ),
    };
    const workflowEngine = { startWorkflow: jest.fn().mockResolvedValue(undefined) };
    const automation = { runAutomationsForEvent: jest.fn().mockResolvedValue(undefined) };
    const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined) };
    const service = new LeavesWriteService(
      db as never,
      { logCritical: jest.fn() } as never,
      {} as never,
      automation as never,
      workflowEngine as never,
      cache as never,
      { membersWithPermission: jest.fn().mockResolvedValue([]) } as never,
      {
        resolve: jest.fn().mockResolvedValue({
          id: "manager-1",
          name: "Manager",
        }),
      } as never,
      { isOnProbationDuring: jest.fn().mockResolvedValue(false) } as never,
    );
    const afterCommit: AfterCommitHook[] = [];
    const context = {
      orgId: USER.orgId,
      audience: "INTERNAL",
      tx: tx as never,
      afterCommit,
    } as TenantContext;

    await expect(
      runWithTenantContext(context, () =>
        service.create(USER, {
          leaveTypeId: 1,
          startDate: "2026-08-12",
          endDate: "2026-08-12",
          reason: "Medical appointment",
          priority: "MEDIUM",
          isHalfDay: false,
        }),
      ),
    ).resolves.toEqual({ success: true, conflictWarning: undefined });

    expect(insertedValues).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: USER.orgId,
        userId: USER.userId,
        approverId: "manager-1",
      }),
    );
    expect(workflowEngine.startWorkflow).not.toHaveBeenCalled();
    expect(automation.runAutomationsForEvent).not.toHaveBeenCalled();
    expect(afterCommit).toHaveLength(1);
  });
});
