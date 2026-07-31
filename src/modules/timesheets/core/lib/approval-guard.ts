export interface ApprovalActor {
  userId: string;
  isOrgOwner: boolean;
}

export interface ApprovalPeriodInfo {
  userId: string;
  currentApproverId: string | null;
}

export interface ApprovalDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Decide whether an actor may approve/reject a submitted period.
 *
 * Rules:
 * - Nobody may approve their own period, except an org owner / platform admin
 *   (sole-admin orgs must not be deadlocked).
 * - Org owners and platform admins may act on any period.
 * - If an approver is assigned, only that approver or someone the approver has
 *   delegated to may act (delegateeOfApprover).
 * - If no approver is assigned, any holder of the approvals permission may act
 *   (the caller enforces the permission before invoking this).
 */
export function canActOnPeriod(
  actor: ApprovalActor,
  period: ApprovalPeriodInfo,
  opts: { delegateeOfApprover?: boolean } = {},
): ApprovalDecision {
  const privileged = actor.isOrgOwner;

  if (period.userId === actor.userId && !privileged) {
    return { allowed: false, reason: "You cannot approve or reject your own timesheet" };
  }

  if (privileged) return { allowed: true };

  if (period.currentApproverId) {
    if (period.currentApproverId === actor.userId) return { allowed: true };
    if (opts.delegateeOfApprover) return { allowed: true };
    return {
      allowed: false,
      reason: "Only the assigned approver (or their delegate) can act on this timesheet",
    };
  }

  return { allowed: true };
}
