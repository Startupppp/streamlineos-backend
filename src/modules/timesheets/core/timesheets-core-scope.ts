import { eq, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
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

/**
 * `userId` on the rate preview widens it to another member's billable rate. It
 * cannot be gated on `timesheets:billing:view`, the key the route carries: that
 * key is not scopable, so every holder would resolve `all` and the gate would
 * not bite. It resolves the scopable key every other timesheets read uses for
 * the same parameter, and forces the subject to the caller below `all`.
 */
export async function resolveRatePreviewSubject(
  access: AccessService,
  u: CurrentUserContext,
  requestedUserId: string | undefined,
): Promise<string | undefined> {
  if (!requestedUserId || requestedUserId === u.userId) return requestedUserId;
  const scope = await resolveEntriesScope(access, u);
  return scope === "all" ? requestedUserId : u.userId;
}

export function applyMembershipScope(
  scope: DataScope,
  membershipId: number | null,
  ownerColumn: PgColumn,
): SQL {
  switch (scope) {
    case "all":
      return sql`true`;
    case "team":
    case "own":
      return membershipId !== null ? eq(ownerColumn, membershipId) : sql`false`;
    case "none":
      return sql`false`;
    default:
      return sql`false`;
  }
}
