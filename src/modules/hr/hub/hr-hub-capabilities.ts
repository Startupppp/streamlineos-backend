import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { grantsOrgAdmin } from "../../../common/rbac/grantability";
import { isPersonalTokenPermissionDelegable } from "../../../common/rbac/personal-token-policy";
import type { DataScope } from "../../access/access.types";

export interface HrHubCapabilities {
  canAnalytics: boolean;
  canLeaves: boolean;
  canLeaveCalendar: boolean;
  canAttendanceManage: boolean;
  canAttendanceView: boolean;
  canProbation: boolean;
  canExit: boolean;
  canCases: boolean;
  canDocuments: boolean;
  canInterviews: boolean;
  canOffers: boolean;
  canRequisitions: boolean;
  canRequisitionsManage: boolean;
  canEmployees: boolean;
  canOnboarding: boolean;
  canPayrollRuns: boolean;
  canPayrollRunsCreate: boolean;
  canLeavesApprove: boolean;
  canAssets: boolean;
  canWorkflowsApprove: boolean;
  canAnnouncements: boolean;
  canPerformance: boolean;
  canBenefits: boolean;
  canExpenses: boolean;
  canCompliance: boolean;
}

function permissionAllowed(
  permissionKey: string,
  user: CurrentUserContext,
  permissions: ReadonlyMap<string, DataScope>,
): boolean {
  if (
    user.tokenScopes &&
    (!isPersonalTokenPermissionDelegable(permissionKey) ||
      !user.tokenScopes.includes(permissionKey))
  ) {
    return false;
  }
  if (user.isOrgOwner || grantsOrgAdmin(permissions)) return true;
  const scope = permissions.get(permissionKey);
  return scope !== undefined && scope !== "none";
}

export function buildHrHubCapabilities(
  user: CurrentUserContext,
  permissions: ReadonlyMap<string, DataScope>,
  payrollEnabled: boolean,
): HrHubCapabilities {
  const can = (permissionKey: string): boolean =>
    permissionAllowed(permissionKey, user, permissions);

  return {
    canAnalytics: can("hr:analytics:read"),
    canLeaves: can("hr:leaves:view"),
    canLeaveCalendar: can("hr:leaves:read"),
    canAttendanceManage: can("hr:attendance:manage"),
    canAttendanceView: can("hr:attendance:view"),
    canProbation: can("hr:probation:view"),
    canExit: can("hr:exit:view"),
    canCases: can("hr:cases:view"),
    canDocuments: can("hr:documents:view"),
    canInterviews: can("hr:interviews:view"),
    canOffers: can("hr:offers:view"),
    canRequisitions: can("hr:requisitions:view"),
    canRequisitionsManage: can("hr:requisitions:manage"),
    canEmployees: can("hr:employees:view"),
    canOnboarding: can("hr:onboarding:manage"),
    canPayrollRuns: payrollEnabled && can("payroll:runs:view"),
    canPayrollRunsCreate: payrollEnabled && can("payroll:runs:create"),
    canLeavesApprove: can("hr:leaves:approve"),
    canAssets: can("hr:assets:view"),
    canWorkflowsApprove: can("hr:workflows:approve"),
    canAnnouncements: can("hr:announcements:manage"),
    canPerformance: can("hr:performance:manage"),
    canBenefits: can("hr:benefits:view"),
    canExpenses: can("hr:expenses:view"),
    canCompliance: can("hr:compliance:manage"),
  };
}
