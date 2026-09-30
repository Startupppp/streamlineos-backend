import { LeaveDecisionEffectsService } from "./leave-decision-effects.service";
import {
  DASHBOARD_LEAVE_BALANCE_NAMESPACE,
  DASHBOARD_PENDING_APPROVALS_NAMESPACE,
} from "../../../common/cache/cache-keys";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const ACTOR: CurrentUserContext = {
  userId: "manager-1",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(2, false),
};

const LEAVE_DECISION = {
  userId: "employee-1",
  leaveTypeId: 1,
  startDate: "2026-10-01",
  endDate: "2026-10-03",
};

function buildService(cache: {
  invalidateNamespace: jest.Mock;
  invalidateNamespaceForOrg: jest.Mock;
}) {
  return new LeaveDecisionEffectsService(
    { emit: jest.fn().mockResolvedValue(undefined) } as never,
    { runAutomationsForEvent: jest.fn().mockResolvedValue(undefined) } as never,
    { dispatch: jest.fn().mockReturnValue(undefined) } as never,
    {
      rebuildOpenPeriodForMonth: jest
        .fn()
        .mockResolvedValue(undefined),
    } as never,
    cache as never,
  );
}

describe("LeaveDecisionEffectsService — dashboard leave-balance cache invalidation", () => {
  it("afterApproved bumps DASHBOARD_LEAVE_BALANCE_NAMESPACE so the approver's decision is visible before the 30-second TTL expires", async () => {
    const invalidateNamespaceForOrg = jest.fn().mockResolvedValue(undefined);
    const service = buildService({
      invalidateNamespace: jest.fn().mockResolvedValue(undefined),
      invalidateNamespaceForOrg,
    });
    await service.afterApproved(ACTOR, 10, LEAVE_DECISION, undefined, 0);
    expect(invalidateNamespaceForOrg).toHaveBeenCalledWith(
      "org-1",
      DASHBOARD_LEAVE_BALANCE_NAMESPACE,
    );
  });

  it("afterRevertedToPending bumps DASHBOARD_LEAVE_BALANCE_NAMESPACE so the reverted balance refreshes on the employee's dashboard", async () => {
    const invalidateNamespaceForOrg = jest.fn().mockResolvedValue(undefined);
    const service = buildService({
      invalidateNamespace: jest.fn().mockResolvedValue(undefined),
      invalidateNamespaceForOrg,
    });
    await service.afterRevertedToPending("org-1", "manager-1", LEAVE_DECISION);
    expect(invalidateNamespaceForOrg).toHaveBeenCalledWith(
      "org-1",
      DASHBOARD_LEAVE_BALANCE_NAMESPACE,
    );
  });

  it("afterApproved still invalidates DASHBOARD_PENDING_APPROVALS_NAMESPACE alongside the leave-balance namespace", async () => {
    const invalidateNamespaceForOrg = jest.fn().mockResolvedValue(undefined);
    const service = buildService({
      invalidateNamespace: jest.fn().mockResolvedValue(undefined),
      invalidateNamespaceForOrg,
    });
    await service.afterApproved(ACTOR, 10, LEAVE_DECISION, undefined, 0);
    expect(invalidateNamespaceForOrg).toHaveBeenCalledWith(
      "org-1",
      DASHBOARD_PENDING_APPROVALS_NAMESPACE,
    );
  });
});
