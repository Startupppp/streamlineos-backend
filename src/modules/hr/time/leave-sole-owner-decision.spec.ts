import { LeavesApprovalService } from "./leaves-approval.service";
import type { ApprovalRoute } from "../../directory/approval-authority.types";

/**
 * BUG-HRMS-017. A one-person organisation could raise leave and never close it.
 *
 * `ApprovalAuthorityService.resolve` routes a sole founder's request back to
 * themselves on purpose — no rung and no queue member remains, and dead-ending
 * them is worse. `approve` then refused every self-decision categorically, so the
 * request sat PENDING for ever with balances frozen and the UI offering nothing
 * but "Cannot approve own request".
 *
 * The segregation-of-duties refusal itself must survive: an org with anyone else
 * who can decide still refuses. That is the second case here, and it is the one
 * that matters — a fix that opened self-approval generally would be a worse bug
 * than the one it closed.
 */

function route(overrides: Partial<ApprovalRoute>): ApprovalRoute {
  return {
    kind: "leave",
    subjectUserId: "u-founder",
    permission: "hr:leaves:approve",
    resolvedAt: new Date().toISOString(),
    rung: "queue",
    assignedTo: null,
    approver: null,
    delegation: null,
    queue: null,
    skipped: [],
    slaHours: 24,
    dueAt: new Date().toISOString(),
    escalation: null,
    ownerSelfApproval: false,
    explanation: "",
    ...overrides,
  };
}

function candidate(userId: string) {
  return { userId, membershipId: 1, name: "Asha Rao", email: "asha@example.test", designation: null };
}

/** Reaches the private guard the three decision paths share. */
function guardOf(resolved: ApprovalRoute) {
  const approvals = { resolve: jest.fn().mockResolvedValue(resolved) };
  const service = new LeavesApprovalService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    approvals as never,
  );
  const guard = (
    service as unknown as {
      mayDecideOwnRequest: (orgId: string, userId: string) => Promise<boolean>;
    }
  ).mayDecideOwnRequest.bind(service);
  return { guard, approvals };
}

describe("leave decisions — the sole-owner escape hatch", () => {
  it("lets the sole owner decide their own request, because the router sent it to them", async () => {
    const { guard, approvals } = guardOf(
      route({ ownerSelfApproval: true, approver: candidate("u-founder") }),
    );

    expect(await guard("org-1", "u-founder")).toBe(true);
    expect(approvals.resolve).toHaveBeenCalledWith("org-1", "u-founder", "leave");
  });

  it("still refuses a self-decision when another approver exists", async () => {
    const { guard } = guardOf(
      route({ ownerSelfApproval: false, approver: candidate("u-manager") }),
    );

    expect(await guard("org-1", "u-founder")).toBe(false);
  });

  it("refuses when the route claims the hatch but routed to somebody else", async () => {
    // Belt and braces: the hatch is only honoured for the person it named, so a
    // stale or inconsistent route cannot widen self-approval.
    const { guard } = guardOf(
      route({ ownerSelfApproval: true, approver: candidate("u-manager") }),
    );

    expect(await guard("org-1", "u-founder")).toBe(false);
  });

  it("refuses when the route has no approver at all", async () => {
    const { guard } = guardOf(route({ ownerSelfApproval: true, approver: null }));

    expect(await guard("org-1", "u-founder")).toBe(false);
  });
});
