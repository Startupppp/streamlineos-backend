import { eq, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ScopedRead, type OwnershipScope } from "../../access/scoped-read";
import { AccessService } from "../../access/access.service";

export const TS_ENTRIES_VIEW_PERMISSION = "timesheets:entries:view";
export const TS_TEAM_VIEW_PERMISSION = "timesheets:team:view";
export const TS_APPROVALS_VIEW_PERMISSION = "timesheets:approvals:view";
export const TS_APPROVALS_MANAGE_PERMISSION = "timesheets:approvals:manage";
export const TS_REPORTS_VIEW_PERMISSION = "timesheets:reports:view";
export const TS_PAYROLL_VIEW_PERMISSION = "timesheets:payroll:view";

export async function resolveEntriesScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  const [own, widened] = await Promise.all([
    ScopedRead.for(access, u, TS_ENTRIES_VIEW_PERMISSION),
    ScopedRead.for(access, u, TS_TEAM_VIEW_PERMISSION),
  ]);
  return ScopedRead.broadest(own, widened);
}

export async function resolveApprovalScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  return ScopedRead.for(access, u, TS_APPROVALS_VIEW_PERMISSION);
}

export async function resolveReportsScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  return ScopedRead.for(access, u, TS_REPORTS_VIEW_PERMISSION);
}

export async function resolvePayrollScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  return ScopedRead.for(access, u, TS_PAYROLL_VIEW_PERMISSION);
}

export async function resolveRatePreviewSubject(
  access: AccessService,
  u: CurrentUserContext,
  requestedUserId: string | undefined,
): Promise<string | undefined> {
  if (!requestedUserId || requestedUserId === u.userId) return requestedUserId;
  const read = await resolveEntriesScope(access, u);
  return read.unrestricted ? requestedUserId : u.userId;
}

export function membershipScope(membershipId: number | null, ownerColumn: PgColumn): OwnershipScope {
  return { own: membershipId !== null ? eq(ownerColumn, membershipId) : sql`false` };
}
