export interface ApprovalActor {
  membershipId: number | null;
  isOrgOwner: boolean;
}

export interface ApprovalPeriodInfo {
  userMembershipId: number | null;
  currentApproverMembershipId: number | null;
}

export interface ApprovalDecision {
  allowed: boolean;
  reason?: string;
}

export function canActOnPeriod(
  actor: ApprovalActor,
  period: ApprovalPeriodInfo,
  opts: { delegateeOfApprover?: boolean } = {},
): ApprovalDecision {
  const privileged = actor.isOrgOwner;

  if (
    period.userMembershipId !== null &&
    actor.membershipId !== null &&
    period.userMembershipId === actor.membershipId &&
    !privileged
  ) {
    return { allowed: false, reason: "You cannot approve or reject your own timesheet" };
  }

  if (privileged) return { allowed: true };

  if (period.currentApproverMembershipId !== null) {
    if (period.currentApproverMembershipId === actor.membershipId) return { allowed: true };
    if (opts.delegateeOfApprover) return { allowed: true };
    return {
      allowed: false,
      reason: "Only the assigned approver (or their delegate) can act on this timesheet",
    };
  }

  return { allowed: true };
}
