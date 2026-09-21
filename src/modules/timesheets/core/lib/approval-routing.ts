import type { TimesheetApprovalRoute } from "../../../../db/schema/timesheets/periods";
import type { ApprovalCandidate, ApprovalRoute } from "../../../directory/approval-authority.types";

export const TIMESHEET_APPROVAL_SLA_HOURS = 48;

export type TimesheetApprovalMode = "MANAGER" | "AUTO" | "MULTI_LEVEL";
export type TimesheetApproverSource = "REPORTING_MANAGER" | "PROJECT_MANAGER";

export interface TimesheetRoutingSettings {
  approvalMode: TimesheetApprovalMode;
  approverSource: TimesheetApproverSource;
}

export type ProjectManagerUnusableReason = "self" | "not-live" | "lacks-permission" | "unassigned";

export interface DominantProjectManager {
  projectId: number;
  projectName: string;
  manager: ApprovalCandidate | null;
  unusable: ProjectManagerUnusableReason | null;
}

export type TimesheetRoutingDecision =
  | { kind: "auto"; route: TimesheetApprovalRoute }
  | { kind: "routed"; approver: ApprovalCandidate | null; queueUserIds: string[]; route: TimesheetApprovalRoute; dueAt: Date }
  | { kind: "unowned"; explanation: string };

const UNUSABLE_EXPLANATIONS: Record<ProjectManagerUnusableReason, string> = {
  self: "you manage that project yourself",
  "not-live": "its manager is no longer an active employee",
  "lacks-permission": "its manager cannot approve timesheets",
  unassigned: "it has no manager",
};

function displayName(candidate: ApprovalCandidate): string {
  return candidate.name?.trim() || candidate.email;
}

function chainRoute(chain: ApprovalRoute, projectId: number | null, prefix: string): TimesheetApprovalRoute {
  return {
    source: "reporting_manager",
    rung: chain.rung,
    approverUserId: chain.approver?.userId ?? null,
    approverMembershipId: chain.approver?.membershipId ?? null,
    assignedToUserId: chain.assignedTo?.userId ?? null,
    delegation: chain.delegation
      ? { fromUserId: chain.delegation.fromUserId, toUserId: chain.delegation.toUserId, endsAt: chain.delegation.endsAt }
      : null,
    projectId,
    explanation: prefix ? `${prefix} ${chain.explanation}` : chain.explanation,
    slaHours: chain.slaHours,
    escalationRung: chain.escalation?.rung ?? null,
    escalatedFrom: null,
  };
}

export function decideTimesheetRoute(
  settings: TimesheetRoutingSettings,
  chain: ApprovalRoute,
  dominantProject: DominantProjectManager | null,
  at: Date,
): TimesheetRoutingDecision {
  if (settings.approvalMode === "AUTO") {
    return {
      kind: "auto",
      route: {
        source: "auto",
        rung: null,
        approverUserId: null,
        approverMembershipId: null,
        assignedToUserId: null,
        delegation: null,
        projectId: dominantProject?.projectId ?? null,
        explanation: "Approved automatically: this organisation approves timesheets without review.",
        slaHours: 0,
        escalationRung: null,
        escalatedFrom: null,
      },
    };
  }

  let prefix = "";
  if (settings.approverSource === "PROJECT_MANAGER") {
    if (dominantProject?.manager && dominantProject.unusable === null) {
      const manager = dominantProject.manager;
      return {
        kind: "routed",
        approver: manager,
        queueUserIds: [],
        route: {
          source: "project_manager",
          rung: null,
          approverUserId: manager.userId,
          approverMembershipId: manager.membershipId,
          assignedToUserId: manager.userId,
          delegation: null,
          projectId: dominantProject.projectId,
          explanation: `${displayName(manager)} approves as manager of ${dominantProject.projectName}, the project with most of this period's hours; this organisation routes timesheets to the project manager.`,
          slaHours: TIMESHEET_APPROVAL_SLA_HOURS,
          escalationRung: "reporting_manager",
          escalatedFrom: null,
        },
        dueAt: new Date(at.getTime() + TIMESHEET_APPROVAL_SLA_HOURS * 3_600_000),
      };
    }
    prefix = dominantProject
      ? `This organisation routes timesheets to the project manager, but ${dominantProject.projectName} could not take it because ${UNUSABLE_EXPLANATIONS[dominantProject.unusable ?? "unassigned"]}.`
      : "This organisation routes timesheets to the project manager, but this period has no project hours.";
  }

  if (chain.rung === null) return { kind: "unowned", explanation: prefix ? `${prefix} ${chain.explanation}` : chain.explanation };

  return {
    kind: "routed",
    approver: chain.approver,
    queueUserIds: chain.rung === "queue" ? (chain.queue?.members.map((member) => member.userId) ?? []) : [],
    route: chainRoute(chain, dominantProject?.projectId ?? null, prefix),
    dueAt: new Date(chain.dueAt),
  };
}

export function dominantProjectId(entries: ReadonlyArray<{ projectId: number | null }>): number | null {
  const frequency = new Map<number, number>();
  for (const entry of entries) if (entry.projectId !== null) frequency.set(entry.projectId, (frequency.get(entry.projectId) ?? 0) + 1);
  let top: number | null = null;
  let topCount = 0;
  for (const [projectId, count] of frequency) {
    if (count > topCount || (count === topCount && top !== null && projectId < top)) {
      top = projectId;
      topCount = count;
    }
  }
  return top;
}
