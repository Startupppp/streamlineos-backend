import type { ApprovalCandidate, ApprovalRoute } from "../../../directory/approval-authority.types";
import {
  TIMESHEET_APPROVAL_SLA_HOURS,
  decideTimesheetRoute,
  dominantProjectId,
  type DominantProjectManager,
  type TimesheetRoutingSettings,
} from "../lib/approval-routing";

const AT = new Date("2026-09-21T09:00:00.000Z");

function candidate(label: string, membershipId: number): ApprovalCandidate {
  return { userId: `usr-${label}`, membershipId, name: label, email: `${label}@example.test`, designation: null };
}

const MANAGER = candidate("manager", 20);
const DIRECTOR = candidate("director", 30);
const PROJECT_MANAGER = candidate("pm", 40);

function chain(overrides: Partial<ApprovalRoute> = {}): ApprovalRoute {
  return {
    kind: "timesheet",
    subjectUserId: "usr-employee",
    permission: "timesheets:approvals:manage",
    resolvedAt: AT.toISOString(),
    rung: "reporting_manager",
    assignedTo: MANAGER,
    approver: MANAGER,
    delegation: null,
    queue: null,
    skipped: [],
    slaHours: 48,
    dueAt: new Date(AT.getTime() + 48 * 3_600_000).toISOString(),
    escalation: { rung: "managers_manager", approver: DIRECTOR, queue: null },
    ownerSelfApproval: false,
    explanation: "manager approves as reporting manager.",
    ...overrides,
  };
}

function project(overrides: Partial<DominantProjectManager> = {}): DominantProjectManager {
  return { projectId: 9, projectName: "Apollo", manager: PROJECT_MANAGER, unusable: null, ...overrides };
}

const REPORTING: TimesheetRoutingSettings = { approvalMode: "MANAGER", approverSource: "REPORTING_MANAGER" };
const PROJECT: TimesheetRoutingSettings = { approvalMode: "MANAGER", approverSource: "PROJECT_MANAGER" };

describe("decideTimesheetRoute — who approves a timesheet and why", () => {
  it("routes to the reporting manager by default even when the period's project has a manager", () => {
    const decision = decideTimesheetRoute(REPORTING, chain(), project(), AT);

    expect(decision.kind).toBe("routed");
    if (decision.kind !== "routed") return;
    expect(decision.approver).toEqual(MANAGER);
    expect(decision.route).toMatchObject({
      source: "reporting_manager",
      rung: "reporting_manager",
      approverMembershipId: MANAGER.membershipId,
      projectId: 9,
      escalationRung: "managers_manager",
      explanation: "manager approves as reporting manager.",
    });
    expect(decision.dueAt.toISOString()).toBe(chain().dueAt);
  });

  it("falls to the manager's manager, and says so, when the chain skipped an inactive reporting manager", () => {
    const skipped = chain({
      rung: "managers_manager",
      approver: DIRECTOR,
      assignedTo: DIRECTOR,
      skipped: [{ rung: "reporting_manager", userId: MANAGER.userId, reason: "manager-exited" }],
      escalation: { rung: "queue", approver: null, queue: { permission: "timesheets:approvals:manage", label: "Timesheet approvals queue", memberCount: 2, members: [] } },
      explanation: "director approves as manager's manager because reporting manager: the manager has exited.",
    });

    const decision = decideTimesheetRoute(REPORTING, skipped, null, AT);

    expect(decision).toMatchObject({ kind: "routed", approver: DIRECTOR, route: { rung: "managers_manager", escalationRung: "queue" } });
    if (decision.kind === "routed") expect(decision.route.explanation).toContain("the manager has exited");
  });

  it("keeps the delegate as the person to notify while recording who delegated", () => {
    const delegate = candidate("delegate", 50);
    const delegated = chain({
      assignedTo: delegate,
      approver: delegate,
      delegation: { source: "workflow", delegationId: "delegation-1", fromUserId: MANAGER.userId, toUserId: delegate.userId, endsAt: "2026-09-30T00:00:00.000Z", reason: "leave" },
    });

    const decision = decideTimesheetRoute(REPORTING, delegated, null, AT);

    expect(decision).toMatchObject({
      kind: "routed",
      approver: delegate,
      route: { approverUserId: delegate.userId, assignedToUserId: delegate.userId, delegation: { fromUserId: MANAGER.userId, toUserId: delegate.userId } },
    });
  });

  it("routes to the queue's members when no manager in the chain can act", () => {
    const queued = chain({
      rung: "queue",
      approver: null,
      assignedTo: null,
      queue: { permission: "timesheets:approvals:manage", label: "Timesheet approvals queue", memberCount: 2, members: [MANAGER, DIRECTOR] },
      escalation: null,
      explanation: "Routed to the Timesheet approvals queue (2 approvers) because reporting manager: no reporting manager is on record.",
    });

    const decision = decideTimesheetRoute(REPORTING, queued, null, AT);

    expect(decision).toMatchObject({ kind: "routed", approver: null, queueUserIds: [MANAGER.userId, DIRECTOR.userId], route: { rung: "queue", approverMembershipId: null, escalationRung: null } });
  });

  it("refuses to own the request, rather than inventing an approver, when the whole chain is empty", () => {
    const empty = chain({ rung: null, approver: null, assignedTo: null, escalation: null, explanation: "Nobody can approve this timesheet." });

    expect(decideTimesheetRoute(REPORTING, empty, project(), AT)).toEqual({ kind: "unowned", explanation: "Nobody can approve this timesheet." });
  });

  it("uses the dominant project's manager only when the organisation deliberately chose project routing", () => {
    const decision = decideTimesheetRoute(PROJECT, chain(), project(), AT);

    expect(decision.kind).toBe("routed");
    if (decision.kind !== "routed") return;
    expect(decision.approver).toEqual(PROJECT_MANAGER);
    expect(decision.route).toMatchObject({
      source: "project_manager",
      rung: null,
      projectId: 9,
      slaHours: TIMESHEET_APPROVAL_SLA_HOURS,
      escalationRung: "reporting_manager",
    });
    expect(decision.route.explanation).toContain("pm approves as manager of Apollo");
    expect(decision.dueAt.getTime()).toBe(AT.getTime() + TIMESHEET_APPROVAL_SLA_HOURS * 3_600_000);
  });

  it.each<[DominantProjectManager["unusable"], string]>([
    ["self", "you manage that project yourself"],
    ["not-live", "its manager is no longer an active employee"],
    ["lacks-permission", "its manager cannot approve timesheets"],
    ["unassigned", "it has no manager"],
  ])("falls back to the reporting chain and explains why the project manager (%s) could not take it", (unusable, reason) => {
    const decision = decideTimesheetRoute(PROJECT, chain(), project({ unusable, manager: unusable === "unassigned" ? null : PROJECT_MANAGER }), AT);

    expect(decision).toMatchObject({ kind: "routed", approver: MANAGER, route: { source: "reporting_manager", projectId: 9 } });
    if (decision.kind === "routed")
      expect(decision.route.explanation).toBe(`This organisation routes timesheets to the project manager, but Apollo could not take it because ${reason}. manager approves as reporting manager.`);
  });

  it("explains that a period with no project hours cannot use project routing", () => {
    const decision = decideTimesheetRoute(PROJECT, chain(), null, AT);

    expect(decision).toMatchObject({ kind: "routed", approver: MANAGER, route: { source: "reporting_manager", projectId: null } });
    if (decision.kind === "routed")
      expect(decision.route.explanation).toBe("This organisation routes timesheets to the project manager, but this period has no project hours. manager approves as reporting manager.");
  });

  it("carries the project-routing explanation into the refusal when the chain is empty too", () => {
    const empty = chain({ rung: null, approver: null, assignedTo: null, escalation: null, explanation: "Nobody can approve this timesheet." });

    expect(decideTimesheetRoute(PROJECT, empty, project({ unusable: "unassigned", manager: null }), AT)).toEqual({
      kind: "unowned",
      explanation: "This organisation routes timesheets to the project manager, but Apollo could not take it because it has no manager. Nobody can approve this timesheet.",
    });
  });

  it("approves automatically, with no approver and no deadline, when the organisation does not review timesheets", () => {
    const decision = decideTimesheetRoute({ approvalMode: "AUTO", approverSource: "PROJECT_MANAGER" }, chain(), project(), AT);

    expect(decision).toEqual({
      kind: "auto",
      route: expect.objectContaining({ source: "auto", rung: null, approverMembershipId: null, projectId: 9, slaHours: 0, escalationRung: null }),
    });
  });

  it("treats the legacy MULTI_LEVEL mode as single manager approval", () => {
    const decision = decideTimesheetRoute({ approvalMode: "MULTI_LEVEL", approverSource: "REPORTING_MANAGER" }, chain(), null, AT);

    expect(decision).toMatchObject({ kind: "routed", approver: MANAGER, route: { source: "reporting_manager" } });
  });
});

describe("dominantProjectId — the project that owns most of a period's entries", () => {
  it("picks the project with the most entries", () => {
    expect(dominantProjectId([{ projectId: 3 }, { projectId: 5 }, { projectId: 5 }, { projectId: null }])).toBe(5);
  });

  it("breaks a tie towards the lower id so the choice is stable across submits", () => {
    expect(dominantProjectId([{ projectId: 8 }, { projectId: 2 }, { projectId: 8 }, { projectId: 2 }])).toBe(2);
  });

  it("returns null when no entry names a project", () => {
    expect(dominantProjectId([{ projectId: null }, { projectId: null }])).toBeNull();
    expect(dominantProjectId([])).toBeNull();
  });
});
