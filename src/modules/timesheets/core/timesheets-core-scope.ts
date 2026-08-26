import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";
import { AccessService } from "../../access/access.service";

export const TS_TEAM_VIEW_PERMISSION = "timesheets:team:view";
export const TS_APPROVALS_VIEW_PERMISSION = "timesheets:approvals:view";
export const TS_REPORTS_VIEW_PERMISSION = "timesheets:reports:view";
export const TS_PAYROLL_VIEW_PERMISSION = "timesheets:payroll:view";

export async function resolveEntriesScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  return access.scopeFor(u, TS_TEAM_VIEW_PERMISSION);
}

export async function resolveApprovalScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  return access.scopeFor(u, TS_APPROVALS_VIEW_PERMISSION);
}

export async function resolveReportsScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  return access.scopeFor(u, TS_REPORTS_VIEW_PERMISSION);
}

export async function resolvePayrollScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  return access.scopeFor(u, TS_PAYROLL_VIEW_PERMISSION);
}
